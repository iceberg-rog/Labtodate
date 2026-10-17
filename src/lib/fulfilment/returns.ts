import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { sendInternalEmail, type EmailAttachment } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { uploadObject, getObjectBytes } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { fmtDocDay } from '@/lib/documents/render';
import { withUniqueTicketRef } from '@/lib/support/actions';
import { formatPrice } from '@/lib/utils';
import {
  fillTemplate,
  OPEN_RETURN_STATUSES,
  RETURN_TYPE_LABEL,
  returnEligibility,
  type ReturnTypeCode,
} from './rules';
import {
  fulfilmentText,
  photosRequiredFor,
  receivingAddress,
  returnFileMaxBytes,
  returnFreightLine,
  returnMaxFiles,
  returnReasons,
  returnsEnabled,
  returnWindowDays,
  warrantyClaimsAfterWindow,
} from './policy';
import { mailOutcomeText, orderUrl, sendBuyerMail } from './mail';
import { createRefund, type RefundMethod } from '@/lib/finance/refunds';

/**
 * Returns / complaints / warranty claims (B14 minimal), as an RMA:
 *   REQUESTED → APPROVED (instructions, or “keep the goods”) | DENIED (reason)
 *   APPROVED → IN_TRANSIT (buyer's tracking) → RECEIVED → INSPECTED (grade +
 *   restock decision: the ONLY place a shipped unit goes back to stock, A10)
 *   → RESOLVED (refund / credit via the refund ledger, repair, replacement, none).
 * Every step is a compare-and-set on the status (double clicks / stale tabs do
 * nothing) and tells the buyer what happened. Server-internal.
 */

export type Actor = { id: string | null; email: string | null };
export type Result = { ok: true; message: string } | { ok: false; message: string };
class Refused extends Error {}

const ORDER_FOR_RETURN = {
  id: true, orderNumber: true, status: true, shippedAt: true, deliveredAt: true, currency: true, buyerId: true,
  buyer: { select: { id: true, name: true, email: true } },
  items: { select: { id: true, titleSnapshot: true, quantity: true, priceCentsSnapshot: true, warrantyMonthsSnapshot: true, productId: true } },
  shipments: { select: { shippedAt: true, deliveredAt: true, items: { select: { orderItemId: true, qty: true } } } },
  returnRequests: { select: { status: true } },
} satisfies Prisma.OrderSelect;

/** Units of each line that have shipped (only those can come back). */
function shippedUnits(o: Prisma.OrderGetPayload<{ select: typeof ORDER_FOR_RETURN }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of o.shipments) for (const i of s.items) out[i.orderItemId] = (out[i.orderItemId] ?? 0) + i.qty;
  return out;
}

export async function returnContext(orderId: string, now = new Date()) {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_FOR_RETURN });
  if (!o) return null;
  const firstShip = o.shipments.map((s) => s.shippedAt).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? o.shippedAt;
  const elig = returnEligibility(
    {
      status: o.status,
      shippedAt: firstShip ?? null,
      deliveredAt: o.deliveredAt,
      warrantyMonths: o.items.map((i) => i.warrantyMonthsSnapshot),
      openReturn: o.returnRequests.some((r) => (OPEN_RETURN_STATUSES as readonly string[]).includes(r.status)),
    },
    { enabled: returnsEnabled(), windowDays: returnWindowDays(), warrantyAfterWindow: warrantyClaimsAfterWindow() },
    now,
  );
  const reasons = returnReasons().filter((r) => !elig.onlyWarranty || r.type === 'WARRANTY');
  return { order: o, eligibility: elig, reasons, shipped: shippedUnits(o), photosFor: photosRequiredFor(), maxFiles: returnMaxFiles(), maxMb: Math.round(returnFileMaxBytes() / 1048576) };
}

async function storeFiles(files: File[], prefix: string, max: number): Promise<{ ok: true; keys: string[] } | { ok: false; message: string }> {
  const real = files.filter((f) => f && typeof f !== 'string' && f.size > 0);
  if (real.length > max) return { ok: false, message: `At most ${max} files.` };
  const keys: string[] = [];
  for (const f of real) {
    const up = await readVerifiedUpload(f, { allow: ['jpeg', 'png', 'webp', 'gif', 'pdf'], maxBytes: returnFileMaxBytes(), label: `“${f.name.slice(0, 60)}”` });
    if (!up.ok) return { ok: false, message: up.error };
    const key = `${prefix}/${randomBytes(24).toString('hex')}.${up.upload.ext}`;
    await uploadObject(key, up.upload.buf, up.upload.mime);
    keys.push(key);
  }
  return { ok: true, keys };
}

/** Buyer (or staff on the buyer's behalf) reports a problem / requests a return. */
export async function createReturnRequest(
  p: { orderId: string; reasonLabel: string; description: string; lines: Array<{ orderItemId: string; qty: number }>; files: File[]; openedBy: 'BUYER' | 'STAFF' },
  actor: Actor,
): Promise<Result & { rmaNumber?: string }> {
  const ctx = await returnContext(p.orderId);
  if (!ctx) return { ok: false, message: 'Order not found.' };
  const o = ctx.order;
  if (p.openedBy === 'BUYER' && !ctx.eligibility.canRequest) return { ok: false, message: ctx.eligibility.reason ?? 'This order can not be returned online.' };
  if (p.openedBy === 'STAFF') {
    if (!['SHIPPED', 'DELIVERED', 'REFUNDED'].includes(o.status) && !o.shipments.length) return { ok: false, message: 'Nothing of this order has shipped — cancel it instead of opening a return.' };
    if (o.returnRequests.some((r) => (OPEN_RETURN_STATUSES as readonly string[]).includes(r.status))) return { ok: false, message: 'This order already has an open return — handle that one first.' };
  }
  const reason = (p.openedBy === 'STAFF' ? returnReasons() : ctx.reasons).find((r) => r.label === p.reasonLabel);
  if (!reason) return { ok: false, message: ctx.eligibility.onlyWarranty && p.openedBy === 'BUYER' ? 'After the return window only a warranty claim is possible — choose a warranty reason.' : 'Choose a reason from the list.' };
  const description = p.description.trim().slice(0, 4000);
  if (description.length < 10) return { ok: false, message: 'Describe the problem (at least 10 characters) — what is wrong, and what you see.' };
  const lines = p.lines.filter((l) => l.qty > 0);
  if (!lines.length) return { ok: false, message: 'Choose the item(s) this is about.' };
  for (const l of lines) {
    const max = ctx.shipped[l.orderItemId] ?? 0;
    if (!Number.isInteger(l.qty) || l.qty > max) return { ok: false, message: max ? `At most ${max} unit(s) of an item can be returned (that many were shipped).` : 'That item has not shipped.' };
  }
  const realFiles = p.files.filter((f) => f && typeof f !== 'string' && f.size > 0);
  if (p.openedBy === 'BUYER' && ctx.photosFor.includes(reason.type) && !realFiles.length) {
    return { ok: false, message: `Add at least one photo for “${reason.label}” — it lets us (and the carrier) assess the damage.` };
  }
  const stored = await storeFiles(realFiles, 'return-files', ctx.maxFiles);
  if (!stored.ok) return { ok: false, message: stored.message };

  const n = await prisma.returnRequest.count({ where: { orderId: o.id } });
  const rmaNumber = `RMA-${o.orderNumber.replace(/^L2D-/i, '')}-${n + 1}`;
  let created: { id: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${o.id} FOR UPDATE`;
      const open = await tx.returnRequest.count({ where: { orderId: o.id, status: { in: [...OPEN_RETURN_STATUSES] } } });
      if (open) throw new Refused('There is already an open request for this order — follow it on the order page.');
      return tx.returnRequest.create({
        data: {
          rmaNumber, orderId: o.id, type: reason.type, reasonCode: reason.label, description, attachments: stored.keys,
          openedBy: p.openedBy, createdById: actor.id,
          items: { create: lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty })) },
        },
        select: { id: true },
      });
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { ok: false, message: 'A request was just created for this order — reload the page.' };
    throw e;
  }
  // A conversation thread for it (Support), linked to the order — high priority.
  const itemsText = lines.map((l) => `${l.qty} × ${o.items.find((i) => i.id === l.orderItemId)?.titleSnapshot ?? 'item'}`).join(', ');
  let ticketRef: string | null = null;
  try {
    const t = await withUniqueTicketRef((ref) => prisma.supportTicket.create({
      data: {
        ref, name: o.buyer.name, email: o.buyer.email, subject: `${rmaNumber} — ${RETURN_TYPE_LABEL[reason.type]} — order ${o.orderNumber}`.slice(0, 160),
        category: 'Return/refund', priority: 'HIGH', orderId: o.id, submittedById: o.buyerId,
        messages: { create: { fromStaff: p.openedBy === 'STAFF', authorId: actor.id, body: `${reason.label} — ${itemsText}\n\n${description}` } },
      },
      select: { id: true, ref: true },
    }));
    ticketRef = t.ref;
    await prisma.returnRequest.update({ where: { id: created.id }, data: { ticketId: t.id } });
  } catch {
    // The RMA itself is saved; the thread is a convenience.
  }
  const mail = await sendBuyerMail({
    to: o.buyer.email,
    subject: `[${rmaNumber}] We received your request — order ${o.orderNumber}`,
    heading: 'We received your request',
    text: fillTemplate(fulfilmentText('RETURN_EMAIL_RECEIVED_TEXT'), { RMA: rmaNumber, ORDER: o.orderNumber, REASON: reason.label }),
    table: [['Request', escapeHtml(rmaNumber)], ['Items', `<span dir="auto">${escapeHtml(itemsText)}</span>`], ['Photos / files', String(stored.keys.length)]],
    cta: { href: orderUrl(o.orderNumber), label: 'Follow it on your order page' },
    footer: ticketRef ? [`Conversation: support ticket ${escapeHtml(ticketRef)} (Account → Support)`] : [],
    context: 'returns:received',
  });
  await notifyUser(o.buyer.id, `${rmaNumber}: request received`, 'We review it and reply by email.', `/app/orders/${o.orderNumber}`);
  await notifyAdmins(`New ${RETURN_TYPE_LABEL[reason.type].toLowerCase()} ${rmaNumber} — order ${o.orderNumber}`, `${reason.label} · ${itemsText}${p.openedBy === 'STAFF' ? ` · opened by ${actor.email}` : ''}`, `/admin/orders/${o.id}#returns`, 'SYSTEM');
  const ops = settingString('SUPPORT_INTAKE_EMAIL') || settingString('SUPPORT_EMAIL');
  await sendInternalEmail({ to: ops, subject: `[${rmaNumber}] ${RETURN_TYPE_LABEL[reason.type]} — order ${o.orderNumber}`, html: `<p>${escapeHtml(o.buyer.name)} (${escapeHtml(o.buyer.email)}): <strong>${escapeHtml(reason.label)}</strong> — ${escapeHtml(itemsText)}</p><p>${escapeHtml(description)}</p><p>${stored.keys.length} file(s). Review it in the admin (Orders → Returns).</p>` }, 'returns:ops');
  await audit('return.create', rmaNumber, `order ${o.orderNumber} · ${reason.type} · ${reason.label} · by ${p.openedBy} ${actor.email ?? ''} · files ${stored.keys.length} · email ${mail.ok ? 'ok' : mail.error}`);
  return {
    ok: true,
    rmaNumber,
    message: p.openedBy === 'BUYER'
      ? `Request ${rmaNumber} sent. ${mail.ok ? 'We emailed you a confirmation.' : 'We could not email you a confirmation right now — this page shows its status.'} Please do not send anything back before we approve it.`
      : `Return ${rmaNumber} opened for the buyer. ${mailOutcomeText(mail)}`,
  };
}

async function loadReturn(id: string) {
  return prisma.returnRequest.findUnique({
    where: { id },
    select: {
      id: true, rmaNumber: true, status: true, type: true, reasonCode: true, noReturnNeeded: true, labelKey: true, receivedAt: true,
      items: { select: { orderItemId: true, qty: true } },
      order: { select: { id: true, orderNumber: true, currency: true, buyerId: true, buyer: { select: { id: true, name: true, email: true } }, items: { select: { id: true, titleSnapshot: true, productId: true, priceCentsSnapshot: true } } } },
    },
  });
}

function defaultInstructions(rma: string): string {
  const freight = returnFreightLine();
  return `${fillTemplate(fulfilmentText('RETURN_INSTRUCTIONS_TEXT'), { RMA: rma, ADDRESS: receivingAddress() || '(our address follows by email)' })}${freight ? `\n${freight}` : ''}`;
}

export function returnInstructionsDraft(rma: string): string {
  return defaultInstructions(rma);
}

export async function approveReturn(p: { returnId: string; instructions: string; noReturnNeeded: boolean; label?: File | null }, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const r = await loadReturn(p.returnId);
  if (!r) return { ok: false, message: 'Return not found.' };
  if (r.status !== 'REQUESTED') return { ok: false, message: `${r.rmaNumber} is already ${r.status.toLowerCase().replace(/_/g, ' ')}.` };
  const instructions = p.noReturnNeeded ? '' : p.instructions.trim().slice(0, 4000);
  if (!p.noReturnNeeded && instructions.length < 20) return { ok: false, message: 'Write the return instructions (where and how to send it) — or tick “nothing has to be sent back”.' };
  if (!p.noReturnNeeded && /\(our address follows by email\)/.test(instructions)) return { ok: false, message: 'The return address is missing — set Settings → Acquisitions → Receiving warehouse address, or type the address into the instructions.' };
  let labelKey: string | null = null;
  let labelAtt: EmailAttachment | null = null;
  if (p.label && p.label.size > 0) {
    const up = await readVerifiedUpload(p.label, { allow: ['pdf', 'png', 'jpeg'], maxBytes: 10 * 1024 * 1024, label: 'Return label' });
    if (!up.ok) return { ok: false, message: up.error };
    labelKey = `return-labels/${randomBytes(24).toString('hex')}.${up.upload.ext}`;
    await uploadObject(labelKey, up.upload.buf, up.upload.mime);
    labelAtt = { filename: `${r.rmaNumber}-label.${up.upload.ext}`, content: up.upload.buf, contentType: up.upload.mime };
  }
  const claim = await prisma.returnRequest.updateMany({
    where: { id: r.id, status: 'REQUESTED' },
    data: { status: labelKey ? 'LABEL_SENT' : 'APPROVED', decidedAt: new Date(), decidedById: actor.id, instructions: instructions || null, noReturnNeeded: p.noReturnNeeded, ...(labelKey ? { labelKey } : {}) },
  });
  if (claim.count !== 1) return { ok: false, message: 'Someone else decided this request a moment ago — reload.' };
  const mail = await sendBuyerMail({
    to: r.order.buyer.email,
    subject: `[${r.rmaNumber}] Approved — order ${r.order.orderNumber}`,
    heading: 'Your request is approved',
    text: fillTemplate(fulfilmentText('RETURN_EMAIL_APPROVED_TEXT'), { RMA: r.rmaNumber, ORDER: r.order.orderNumber }),
    html: p.noReturnNeeded
      ? ['<p style="margin:0 0 12px;"><strong>You do not need to send anything back.</strong> We settle it and email you the outcome.</p>']
      : [`<p style="margin:0 0 6px;"><strong>Return instructions</strong></p><p style="margin:0 0 12px;white-space:pre-wrap;" dir="auto">${escapeHtml(instructions)}</p>`, ...(labelAtt ? ['<p style="margin:0 0 12px;">The return label is attached.</p>'] : []), '<p style="margin:0 0 12px;">When you have sent it, add the carrier and tracking number on your order page.</p>'],
    cta: { href: orderUrl(r.order.orderNumber), label: 'Open your order' },
    attachments: labelAtt ? [labelAtt] : [],
    context: 'returns:approved',
  });
  await notifyUser(r.order.buyer.id, `${r.rmaNumber}: approved`, p.noReturnNeeded ? 'Nothing to send back.' : 'See the return instructions on your order page.', `/app/orders/${r.order.orderNumber}`);
  await audit('return.approve', r.rmaNumber, `by ${actor.email ?? 'staff'}${p.noReturnNeeded ? ' · no return needed' : ''}${labelKey ? ' · label' : ''} · email ${mail.ok ? 'ok' : mail.error}`);
  return { ok: true, message: `${r.rmaNumber} approved. ${mailOutcomeText(mail)}` };
}

export async function rejectReturn(p: { returnId: string; reason: string }, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const reason = p.reason.trim().slice(0, 1000);
  if (reason.length < 10) return { ok: false, message: 'Explain why (at least 10 characters) — the buyer receives this text.' };
  const r = await loadReturn(p.returnId);
  if (!r) return { ok: false, message: 'Return not found.' };
  if (r.status !== 'REQUESTED') return { ok: false, message: `${r.rmaNumber} is already ${r.status.toLowerCase().replace(/_/g, ' ')}.` };
  const claim = await prisma.returnRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'DENIED', decidedAt: new Date(), decidedById: actor.id, decisionReason: reason } });
  if (claim.count !== 1) return { ok: false, message: 'Someone else decided this request a moment ago — reload.' };
  const mail = await sendBuyerMail({
    to: r.order.buyer.email,
    subject: `[${r.rmaNumber}] About your request — order ${r.order.orderNumber}`,
    heading: 'We can not approve your request',
    text: fillTemplate(fulfilmentText('RETURN_EMAIL_REJECTED_TEXT'), { RMA: r.rmaNumber, ORDER: r.order.orderNumber, REASON: reason }),
    cta: { href: orderUrl(r.order.orderNumber), label: 'Open your order' },
    context: 'returns:rejected',
  });
  await notifyUser(r.order.buyer.id, `${r.rmaNumber}: not approved`, reason.slice(0, 200), `/app/orders/${r.order.orderNumber}`);
  await audit('return.reject', r.rmaNumber, `by ${actor.email ?? 'staff'} · "${reason.slice(0, 160)}" · email ${mail.ok ? 'ok' : mail.error}`);
  return { ok: true, message: `${r.rmaNumber} rejected. ${mailOutcomeText(mail)}` };
}

/** The buyer sent the goods back: carrier + tracking. */
export async function recordReturnShipment(p: { returnId: string; buyerId: string; carrier: string; tracking: string }): Promise<Result> {
  const carrier = p.carrier.trim().slice(0, 60);
  const tracking = p.tracking.trim().slice(0, 80);
  if (carrier.length < 2 || tracking.length < 3) return { ok: false, message: 'Enter the carrier and the tracking number.' };
  const r = await loadReturn(p.returnId);
  if (!r || r.order.buyerId !== p.buyerId) return { ok: false, message: 'Request not found.' };
  if (r.noReturnNeeded) return { ok: false, message: 'Nothing has to be sent back for this request.' };
  if (!['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status)) return { ok: false, message: r.status === 'REQUESTED' ? 'Please wait for our approval before you send anything.' : `This request is ${r.status.toLowerCase().replace(/_/g, ' ')}.` };
  const claim = await prisma.returnRequest.updateMany({ where: { id: r.id, status: { in: ['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'] } }, data: { status: 'IN_TRANSIT', returnCarrier: carrier, returnTracking: tracking } });
  if (claim.count !== 1) return { ok: false, message: 'The request changed meanwhile — reload.' };
  await notifyAdmins(`${r.rmaNumber}: goods on their way back`, `${carrier} · ${tracking} — order ${r.order.orderNumber}`, `/admin/orders/${r.order.id}#returns`, 'SYSTEM');
  await audit('return.in-transit', r.rmaNumber, `${carrier} ${tracking}`);
  return { ok: true, message: `Thanks — we expect ${r.rmaNumber} via ${carrier} (${tracking}) and email you when it arrives.` };
}

export async function receiveReturn(p: { returnId: string; receivedAt: Date; note: string | null }, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  if (p.receivedAt.getTime() > Date.now() + 36e5) return { ok: false, message: 'The receipt date can not be in the future.' };
  const r = await loadReturn(p.returnId);
  if (!r) return { ok: false, message: 'Return not found.' };
  if (r.noReturnNeeded) return { ok: false, message: 'This return was approved without sending goods back — resolve it directly.' };
  if (!['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'].includes(r.status)) return { ok: false, message: r.status === 'REQUESTED' ? 'Approve the request first.' : `${r.rmaNumber} is ${r.status.toLowerCase().replace(/_/g, ' ')}.` };
  const claim = await prisma.returnRequest.updateMany({ where: { id: r.id, status: { in: ['APPROVED', 'LABEL_SENT', 'IN_TRANSIT'] } }, data: { status: 'RECEIVED', receivedAt: p.receivedAt, receivedById: actor.id, ...(p.note ? { inspectionNote: p.note.slice(0, 2000) } : {}) } });
  if (claim.count !== 1) return { ok: false, message: 'The return changed meanwhile — reload.' };
  const mail = await sendBuyerMail({
    to: r.order.buyer.email,
    subject: `[${r.rmaNumber}] We received the returned goods`,
    heading: 'We received the returned goods',
    text: fillTemplate(fulfilmentText('RETURN_EMAIL_RECEIVED_GOODS_TEXT'), { RMA: r.rmaNumber, ORDER: r.order.orderNumber, DATE: fmtDocDay(p.receivedAt) }),
    cta: { href: orderUrl(r.order.orderNumber), label: 'Open your order' },
    context: 'returns:goods-received',
  });
  await audit('return.received', r.rmaNumber, `on ${p.receivedAt.toISOString().slice(0, 10)} by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `${r.rmaNumber} received — inspect it next (grade + restock decision). ${mailOutcomeText(mail)}` };
}

/** Inspection: the only step that puts a returned unit back into sellable stock (A10). */
export async function inspectReturn(p: { returnId: string; grade: 'RESELL' | 'REFURBISH' | 'SCRAP'; note: string; restock: boolean }, actor: Actor): Promise<Result> {
  const note = p.note.trim().slice(0, 2000);
  if (note.length < 5) return { ok: false, message: 'Write what you found (at least 5 characters).' };
  if (p.restock && p.grade !== 'RESELL') return { ok: false, message: 'Only a unit graded “resell” goes back into sellable stock.' };
  const r = await loadReturn(p.returnId);
  if (!r) return { ok: false, message: 'Return not found.' };
  if (r.status !== 'RECEIVED') return { ok: false, message: r.status === 'INSPECTED' ? `${r.rmaNumber} is already inspected.` : 'Record the receipt of the goods first.' };
  let restocked = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.returnRequest.updateMany({ where: { id: r.id, status: 'RECEIVED' }, data: { status: 'INSPECTED', inspectionGrade: p.grade, inspectedAt: new Date(), inspectedById: actor.id, inspectionNote: note } });
      if (claim.count !== 1) throw new Refused('The return changed meanwhile — reload.');
      if (p.restock) {
        for (const it of r.items) {
          const pid = r.order.items.find((i) => i.id === it.orderItemId)?.productId;
          if (!pid) continue;
          const u = await tx.product.updateMany({ where: { id: pid }, data: { quantity: { increment: it.qty } } });
          if (u.count === 1) restocked += it.qty;
        }
        await tx.returnRequest.update({ where: { id: r.id }, data: { restockedQty: restocked } });
      }
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: e.message };
    throw e;
  }
  await audit('return.inspect', r.rmaNumber, `${p.grade} · restocked ${restocked} · "${note.slice(0, 160)}" · by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `${r.rmaNumber} inspected (${p.grade.toLowerCase()}).${p.restock ? ` ${restocked} unit(s) back in sellable stock.` : ' Nothing was put back into stock.'} Resolve it next (refund / credit, repair, replacement or no action).` };
}

export type ReturnOutcome = 'FULL_REFUND' | 'PARTIAL_REFUND' | 'CREDIT' | 'REPLACEMENT' | 'REPAIR' | 'NONE';
export const OUTCOME_LABEL: Record<ReturnOutcome, string> = {
  FULL_REFUND: 'Full refund',
  PARTIAL_REFUND: 'Partial refund',
  CREDIT: 'Credit (invoice not paid yet)',
  REPLACEMENT: 'Replacement',
  REPAIR: 'Repair',
  NONE: 'No action',
};

/** Close the RMA with its outcome; a money outcome goes through the refund ledger + credit note. */
export async function resolveReturn(
  p: { returnId: string; outcome: ReturnOutcome; amountCents: number | null; method: RefundMethod | null; note: string },
  actor: Actor,
): Promise<Result> {
  await ensureSettingsLoaded();
  const note = p.note.trim().slice(0, 1000);
  const r = await loadReturn(p.returnId);
  if (!r) return { ok: false, message: 'Return not found.' };
  const resolvable: Array<'APPROVED' | 'LABEL_SENT' | 'INSPECTED'> = r.noReturnNeeded ? ['APPROVED', 'LABEL_SENT', 'INSPECTED'] : ['INSPECTED'];
  if (!(resolvable as string[]).includes(r.status)) {
    return { ok: false, message: r.status === 'RESOLVED' ? `${r.rmaNumber} is already resolved.` : r.noReturnNeeded ? 'Approve the request first.' : 'Receive and inspect the returned goods before you resolve it.' };
  }
  if (note.length < 5) return { ok: false, message: 'Write the outcome for the buyer (at least 5 characters).' };
  let refundMsg = '';
  if (p.outcome === 'FULL_REFUND' || p.outcome === 'PARTIAL_REFUND' || p.outcome === 'CREDIT') {
    const amount = p.amountCents ?? 0;
    if (amount <= 0) return { ok: false, message: 'Enter the amount to refund / credit.' };
    const ref = await createRefund({ orderId: r.order.id, amountCents: amount, reason: `${r.rmaNumber}: ${note}`, method: p.method, returnId: r.id }, actor);
    if (!ref.ok) return { ok: false, message: `${r.rmaNumber} not resolved — ${ref.message}` };
    refundMsg = ` ${ref.message}`;
  }
  const claim = await prisma.returnRequest.updateMany({ where: { id: r.id, status: { in: resolvable } }, data: { status: 'RESOLVED', outcome: p.outcome, resolvedAt: new Date(), resolvedById: actor.id, resolutionNote: note } });
  if (claim.count !== 1) return { ok: false, message: `${r.rmaNumber} changed meanwhile — reload.${refundMsg}` };
  let mailText = '';
  if (!refundMsg) {
    const mail = await sendBuyerMail({
      to: r.order.buyer.email,
      subject: `[${r.rmaNumber}] Outcome — order ${r.order.orderNumber}`,
      heading: `${OUTCOME_LABEL[p.outcome]}`,
      html: [`<p style="margin:0 0 12px;" dir="auto">${escapeHtml(note)}</p>`],
      cta: { href: orderUrl(r.order.orderNumber), label: 'Open your order' },
      context: 'returns:resolved',
    });
    mailText = ` ${mailOutcomeText(mail)}`;
  }
  await notifyUser(r.order.buyer.id, `${r.rmaNumber}: ${OUTCOME_LABEL[p.outcome].toLowerCase()}`, note.slice(0, 200), `/app/orders/${r.order.orderNumber}`);
  await audit('return.resolve', r.rmaNumber, `${p.outcome}${p.amountCents ? ` ${formatPrice(p.amountCents, r.order.currency)}` : ''} · by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `${r.rmaNumber} resolved: ${OUTCOME_LABEL[p.outcome].toLowerCase()}.${refundMsg}${mailText}` };
}

/** The buyer adds photos / files to their open request (more than fit in one upload). */
export async function addReturnFiles(p: { returnId: string; buyerId: string; files: File[] }): Promise<Result> {
  await ensureSettingsLoaded();
  const r = await prisma.returnRequest.findUnique({ where: { id: p.returnId }, select: { id: true, rmaNumber: true, status: true, attachments: true, order: { select: { id: true, buyerId: true, orderNumber: true } } } });
  if (!r || r.order.buyerId !== p.buyerId) return { ok: false, message: 'Request not found.' };
  if (!(OPEN_RETURN_STATUSES as readonly string[]).includes(r.status)) return { ok: false, message: `${r.rmaNumber} is closed — files can no longer be added.` };
  const room = returnMaxFiles() * 3 - r.attachments.length;
  if (room <= 0) return { ok: false, message: 'This request already has the maximum number of files — use the conversation (Support) for more.' };
  const stored = await storeFiles(p.files, 'return-files', Math.min(room, returnMaxFiles()));
  if (!stored.ok) return { ok: false, message: stored.message };
  if (!stored.keys.length) return { ok: false, message: 'Choose at least one photo or PDF.' };
  await prisma.returnRequest.update({ where: { id: r.id }, data: { attachments: { push: stored.keys } } });
  await notifyAdmins(`${r.rmaNumber}: ${stored.keys.length} file(s) added by the buyer`, `Order ${r.order.orderNumber}`, `/admin/orders/${r.order.id}#returns`, 'SYSTEM');
  await audit('return.files', r.rmaNumber, `+${stored.keys.length}`);
  return { ok: true, message: `${stored.keys.length} file(s) added to ${r.rmaNumber}.` };
}

/** Bytes of a private return file for an authorised viewer (route handler). */
export async function returnFileBytes(key: string) {
  return getObjectBytes(key);
}

export type { ReturnTypeCode };
