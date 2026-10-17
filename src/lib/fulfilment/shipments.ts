import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { checkCountry } from '@/lib/compliance/country';
import { addressCountry } from '@/lib/tax/order';
import { addressLines } from '@/lib/orders/details';
import { audit, notifyAdmins, notifyUser } from '@/lib/observability';
import { escapeHtml } from '@/lib/email-html';
import { fmtDocDay } from '@/lib/documents/render';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { randomBytes } from 'node:crypto';
import { vatIdRule } from '@/lib/quotes/policy';
import {
  buildTrackingUrl,
  fillTemplate,
  findCarrier,
  remainingToShip,
  shipBlockers,
  shipmentLinesProblem,
  shipProgress,
  trackingRequired,
  type ShipProgress,
} from './rules';
import { carriers, emailProcessingEnabled, fulfilmentText, insureByDefault, podMaxBytes, requireTrackingToShip, returnWindowDays } from './policy';
import { mailOutcomeText, orderUrl, sendBuyerMail, type MailOutcome } from './mail';

/**
 * Shipments (B12 minimal) and the shipping notifications (A27). Every path that
 * moves an order towards the carrier — the order page, the list row, the quick
 * view, bulk shipping — ends here, so the address / billing-details gate (owner
 * report 5), the tracking rule and the buyer email are the same everywhere.
 * Server-internal: callers check the session / capability.
 */

export type Actor = { id: string | null; email: string | null };
export type Result = { ok: true; message: string } | { ok: false; message: string };

const ORDER_SELECT = {
  id: true, orderNumber: true, status: true, financialStatus: true, currency: true, customerType: true,
  shippingAddress: true, billingAddress: true, openHolds: true, holdReason: true, shippedAt: true,
  buyer: { select: { id: true, name: true, email: true } },
  items: { select: { id: true, titleSnapshot: true, quantity: true, priceCentsSnapshot: true, lineType: true } },
  shipments: { select: { id: true, seq: true, shippedAt: true, deliveredAt: true, items: { select: { orderItemId: true, qty: true } } }, orderBy: { seq: 'asc' as const } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

function goodsLines(o: { items: Array<{ id: string; quantity: number; lineType: string }> }) {
  return o.items.filter((i) => i.lineType === 'GOODS' || !i.lineType);
}

/** Why the order can not move towards the carrier (empty = it can). Shared by every path. */
export async function orderShipBlockers(o: Pick<OrderRow, 'status' | 'billingAddress' | 'shippingAddress' | 'customerType' | 'openHolds' | 'holdReason'>): Promise<string[]> {
  await ensureSettingsLoaded();
  const country = addressCountry(o.shippingAddress);
  const decision = country ? await checkCountry(country) : null;
  return shipBlockers(
    { ...o, shipCountryMode: decision?.mode ?? null, shipCountry: decision?.name ?? country },
    { vatIdRule: vatIdRule() },
  );
}

export function blockedMessage(orderNumber: string, what: string, blockers: string[]): string {
  return `Order ${orderNumber} can not be ${what}: ${blockers.join('; ')}. Fix that first (billing & delivery details, holds on the order page).`;
}

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
}

/** PAID → PROCESSING (“being prepared”), only when the order could actually ship. */
export async function markOrderProcessing(orderId: string, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'PROCESSING') return { ok: true, message: `Order ${o.orderNumber} is already being prepared.` };
  if (o.status !== 'PAID') return { ok: false, message: `Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — only a paid order can be marked “processing”.` };
  const blockers = await orderShipBlockers(o);
  if (blockers.length) return { ok: false, message: blockedMessage(o.orderNumber, 'marked ready to ship', blockers) };
  const r = await prisma.order.updateMany({ where: { id: o.id, status: 'PAID' }, data: { status: 'PROCESSING' } });
  if (r.count !== 1) return { ok: false, message: 'The order changed meanwhile — reload and check its status.' };
  await notifyUser(o.buyer.id, `Order ${o.orderNumber}: being prepared`, 'We are preparing your order for dispatch.', `/app/orders/${o.orderNumber}`);
  let mail: MailOutcome | null = null;
  if (emailProcessingEnabled()) {
    mail = await sendBuyerMail({
      to: o.buyer.email,
      subject: `Order ${o.orderNumber} is being prepared`,
      heading: 'We are preparing your order',
      text: fillTemplate(fulfilmentText('EMAIL_PROCESSING_TEXT'), { ORDER: o.orderNumber }),
      cta: { href: orderUrl(o.orderNumber), label: 'View your order' },
      context: 'orders:processing',
    });
  }
  await audit('order.processing', o.orderNumber, `by ${actor.email ?? 'staff'}${mail ? ` · email ${mail.ok ? 'ok' : mail.error}` : ' · email off'}`);
  return { ok: true, message: `Order ${o.orderNumber} is now “processing”. ${mail ? mailOutcomeText(mail) : 'No email (Settings → Fulfilment: off); the buyer was notified in-app.'}` };
}

export interface ShipmentInput {
  orderId: string;
  /** Lines + quantities; 'ALL' = everything not shipped yet. */
  lines: Array<{ orderItemId: string; qty: number }> | 'ALL';
  carrier: string;
  trackingNumber: string | null;
  parcels: number;
  grossKg: number | null;
  /** 'DEFAULT' = the goods value of the shipped lines when Settings say “insure by default”. */
  insuredValueCents: number | null | 'DEFAULT';
  shippedAt: Date;
  note: string | null;
}

export type ShipmentResult =
  | { ok: true; message: string; shipmentId: string; seq: number; progress: ShipProgress; mail: MailOutcome }
  | { ok: false; message: string };

class Refused extends Error {}

/**
 * Record a shipment: validates readiness, carrier + tracking, the lines; in ONE
 * transaction (order row locked) creates the Shipment + lines and moves the
 * order to SHIPPED (everything shipped) or keeps it PROCESSING (partial). Then
 * emails the buyer the carrier, tracking link and items — truthfully reported.
 */
export async function recordShipment(input: ShipmentInput, actor: Actor): Promise<ShipmentResult> {
  await ensureSettingsLoaded();
  const o = await prisma.order.findUnique({ where: { id: input.orderId }, select: ORDER_SELECT });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (!['PAID', 'PROCESSING'].includes(o.status)) {
    return { ok: false, message: o.status === 'SHIPPED' || o.status === 'DELIVERED' ? `Everything in order ${o.orderNumber} has already shipped.` : `Order ${o.orderNumber} is ${o.status.toLowerCase().replace(/_/g, ' ')} — it can not be shipped.` };
  }
  const blockers = await orderShipBlockers(o);
  if (blockers.length) return { ok: false, message: blockedMessage(o.orderNumber, 'shipped', blockers) };
  const list = carriers();
  const carrier = findCarrier(list, input.carrier);
  if (!carrier) return { ok: false, message: `Choose a carrier from the list (Settings → Fulfilment & delivery → Carriers).` };
  const tracking = (input.trackingNumber ?? '').trim().slice(0, 80) || null;
  if (!tracking && trackingRequired(carrier, requireTrackingToShip())) {
    return { ok: false, message: `${carrier.name} has tracking: enter the tracking number (Settings → Fulfilment & delivery → “Tracking number required”).` };
  }
  if (tracking && !/^[A-Za-z0-9][A-Za-z0-9 \-./]{2,79}$/.test(tracking)) return { ok: false, message: 'The tracking number may only contain letters, digits, spaces and - . /' };
  if (!Number.isInteger(input.parcels) || input.parcels < 1 || input.parcels > 999) return { ok: false, message: 'Parcels must be a whole number from 1 to 999.' };
  if (input.grossKg != null && (!(input.grossKg > 0) || input.grossKg > 100_000)) return { ok: false, message: 'Gross weight must be a positive number of kg.' };
  if (typeof input.insuredValueCents === 'number' && (!Number.isInteger(input.insuredValueCents) || input.insuredValueCents < 0)) return { ok: false, message: 'Insured value must be an amount of 0 or more.' };
  const now = Date.now();
  if (input.shippedAt.getTime() > now + 36e5) return { ok: false, message: 'The ship date can not be in the future.' };
  if (input.shippedAt.getTime() < now - 60 * 86_400_000) return { ok: false, message: 'The ship date can be at most 60 days ago.' };

  const goods = goodsLines(o);
  const trackingUrl = buildTrackingUrl(carrier, tracking);
  let created: { id: string; seq: number; progress: ShipProgress; lines: Array<{ title: string; qty: number }> };
  try {
    created = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, o.id);
      const fresh = await tx.order.findUnique({ where: { id: o.id }, select: { status: true, shipments: { select: { items: { select: { orderItemId: true, qty: true } } } } } });
      if (!fresh || !['PAID', 'PROCESSING'].includes(fresh.status)) throw new Refused('The order changed meanwhile — reload and check its status.');
      const shipped = fresh.shipments.flatMap((s) => s.items);
      const remaining = remainingToShip(goods, shipped);
      const lines = input.lines === 'ALL'
        ? Object.entries(remaining).filter(([, n]) => n > 0).map(([orderItemId, qty]) => ({ orderItemId, qty }))
        : input.lines.filter((l) => l.qty > 0);
      const problem = shipmentLinesProblem(lines, remaining);
      if (problem) throw new Refused(problem.charAt(0).toUpperCase() + problem.slice(1));
      const seq = fresh.shipments.length + 1;
      const insuredCents = input.insuredValueCents === 'DEFAULT'
        ? (insureByDefault() ? lines.reduce((a, l) => a + l.qty * (o.items.find((i) => i.id === l.orderItemId)?.priceCentsSnapshot ?? 0), 0) : null)
        : input.insuredValueCents;
      const shipment = await tx.shipment.create({
        data: {
          orderId: o.id, seq, carrier: carrier.name, trackingNumber: tracking, trackingUrl,
          parcels: input.parcels, grossKg: input.grossKg, insured: (insuredCents ?? 0) > 0, insuredValueCents: insuredCents,
          shippedAt: input.shippedAt, note: input.note, createdById: actor.id,
          items: { create: lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty })) },
        },
        select: { id: true },
      });
      const progress = shipProgress(goods, [...shipped, ...lines]);
      const moved = await tx.order.updateMany({
        where: { id: o.id, status: { in: ['PAID', 'PROCESSING'] } },
        data: {
          status: progress === 'ALL' ? 'SHIPPED' : 'PROCESSING',
          trackingCarrier: carrier.name,
          trackingNumber: tracking,
          ...(progress === 'ALL' ? { shippedAt: input.shippedAt } : {}),
        },
      });
      if (moved.count !== 1) throw new Refused('The order changed meanwhile — reload and check its status.');
      return {
        id: shipment.id, seq, progress,
        lines: lines.map((l) => ({ title: o.items.find((i) => i.id === l.orderItemId)?.titleSnapshot ?? 'item', qty: l.qty })),
      };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: e.message };
    throw e;
  }

  const mail = await sendShippedEmail(o, { ...created, carrier: carrier.name, tracking, trackingUrl, parcels: input.parcels, shippedAt: input.shippedAt });
  if (mail.ok) await prisma.shipment.update({ where: { id: created.id }, data: { shippedEmailAt: new Date() } });
  await notifyUser(o.buyer.id, `Order ${o.orderNumber}: ${created.progress === 'ALL' ? 'shipped' : 'partly shipped'}`, `${carrier.name}${tracking ? ` · tracking ${tracking}` : ''}`, `/app/orders/${o.orderNumber}`);
  await notifyAdmins(`Order ${o.orderNumber}: shipment ${created.seq} sent${created.progress === 'PARTIAL' ? ' (partial)' : ''}`, `${carrier.name}${tracking ? ` · ${tracking}` : ''} · by ${actor.email ?? 'staff'}`, `/admin/orders/${o.id}`, 'ORDER_SHIPPED');
  await audit('order.shipment', o.orderNumber, `#${created.seq} ${carrier.name} ${tracking ?? '(no tracking)'} · ${created.lines.map((l) => `${l.qty}× ${l.title}`).join(', ').slice(0, 200)} · ${created.progress} · email ${mail.ok ? 'ok' : mail.error}`);
  const what = created.progress === 'ALL' ? `Order ${o.orderNumber} is shipped` : `Shipment ${created.seq} of order ${o.orderNumber} recorded — items are still to ship (the order stays “processing”)`;
  return { ok: true, message: `${what}. ${mailOutcomeText(mail)}`, shipmentId: created.id, seq: created.seq, progress: created.progress, mail };
}

async function sendShippedEmail(
  o: OrderRow,
  s: { seq: number; progress: ShipProgress; lines: Array<{ title: string; qty: number }>; carrier: string; tracking: string | null; trackingUrl: string | null; parcels: number; shippedAt: Date },
): Promise<MailOutcome> {
  const items = s.lines.map((l) => `${l.qty} × ${l.title}`).join(', ');
  const addr = addressLines(o.shippingAddress);
  const shipName = o.shippingAddress && typeof o.shippingAddress === 'object' ? String((o.shippingAddress as Record<string, unknown>).name ?? '') : '';
  return sendBuyerMail({
    to: o.buyer.email,
    subject: fillTemplate(fulfilmentText('EMAIL_SHIPPED_SUBJECT'), { ORDER: o.orderNumber }),
    heading: s.progress === 'ALL' && s.seq === 1 ? 'Your order is on its way' : s.progress === 'ALL' ? 'The rest of your order is on its way' : 'Part of your order is on its way',
    text: fillTemplate(fulfilmentText('EMAIL_SHIPPED_TEXT'), { ITEMS: items, ORDER: o.orderNumber, DATE: fmtDocDay(s.shippedAt), CARRIER: s.carrier }),
    table: [
      ['Carrier', escapeHtml(s.carrier)],
      ['Tracking number', s.tracking ? (s.trackingUrl ? `<a href="${escapeHtml(s.trackingUrl)}">${escapeHtml(s.tracking)}</a>` : escapeHtml(s.tracking)) : 'none for this carrier'],
      ['Parcels', String(s.parcels)],
      ['Delivering to', `<span dir="auto">${escapeHtml([shipName, ...addr].filter(Boolean).join(', '))}</span>`],
    ],
    html: [
      ...(s.trackingUrl ? [`<p style="margin:0 0 12px;"><a href="${escapeHtml(s.trackingUrl)}">Track this shipment on the ${escapeHtml(s.carrier)} website</a></p>`] : []),
      ...(s.progress === 'PARTIAL' ? [`<p style="margin:0 0 12px;">${escapeHtml(fulfilmentText('EMAIL_SHIPPED_REST_TEXT'))}</p>`] : []),
    ],
    cta: { href: orderUrl(o.orderNumber), label: 'View your order' },
    context: 'orders:shipped',
  });
}

/** Change carrier / tracking of a recorded shipment; the buyer gets the new details. */
export async function updateShipmentTracking(p: { shipmentId: string; carrier: string; trackingNumber: string | null }, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const s = await prisma.shipment.findUnique({
    where: { id: p.shipmentId },
    select: { id: true, seq: true, carrier: true, trackingNumber: true, deliveredAt: true, shippedEmailAt: true, orderId: true, order: { select: { orderNumber: true, status: true, buyer: { select: { id: true, email: true } }, shipments: { select: { id: true, seq: true }, orderBy: { seq: 'desc' }, take: 1 } } } },
  });
  if (!s) return { ok: false, message: 'Shipment not found.' };
  if (['CANCELED', 'REFUNDED'].includes(s.order.status)) return { ok: false, message: `Order ${s.order.orderNumber} is ${s.order.status.toLowerCase()} — its shipments can no longer change.` };
  const carrier = findCarrier(carriers(), p.carrier);
  if (!carrier) return { ok: false, message: 'Choose a carrier from the list (Settings → Fulfilment & delivery → Carriers).' };
  const tracking = (p.trackingNumber ?? '').trim().slice(0, 80) || null;
  if (!tracking && trackingRequired(carrier, requireTrackingToShip())) return { ok: false, message: `${carrier.name} has tracking: enter the tracking number.` };
  if (tracking && !/^[A-Za-z0-9][A-Za-z0-9 \-./]{2,79}$/.test(tracking)) return { ok: false, message: 'The tracking number may only contain letters, digits, spaces and - . /' };
  if (carrier.name === s.carrier && tracking === s.trackingNumber) return { ok: true, message: 'Nothing changed.' };
  const trackingUrl = buildTrackingUrl(carrier, tracking);
  const r = await prisma.shipment.updateMany({
    where: { id: s.id, carrier: s.carrier, trackingNumber: s.trackingNumber },
    data: { carrier: carrier.name, trackingNumber: tracking, trackingUrl },
  });
  if (r.count !== 1) return { ok: false, message: 'Someone else changed this shipment a moment ago — reload and check.' };
  if (s.order.shipments[0]?.id === s.id) {
    await prisma.order.update({ where: { id: s.orderId }, data: { trackingCarrier: carrier.name, trackingNumber: tracking } });
  }
  let mail: MailOutcome | null = null;
  if (!s.deliveredAt) {
    mail = await sendBuyerMail({
      to: s.order.buyer.email,
      subject: `New tracking details — order ${s.order.orderNumber}`,
      heading: 'Your tracking details changed',
      text: fillTemplate(fulfilmentText('EMAIL_TRACKING_UPDATED_TEXT'), { ORDER: s.order.orderNumber, CARRIER: carrier.name, TRACKING: tracking ?? 'none' }),
      html: trackingUrl ? [`<p style="margin:0 0 12px;"><a href="${escapeHtml(trackingUrl)}">Track this shipment on the ${escapeHtml(carrier.name)} website</a></p>`] : [],
      cta: { href: orderUrl(s.order.orderNumber), label: 'View your order' },
      context: 'orders:tracking-updated',
    });
    if (mail.ok) await prisma.shipment.update({ where: { id: s.id }, data: { trackingEmailAt: new Date(), ...(s.shippedEmailAt ? {} : { shippedEmailAt: new Date() }) } });
    await notifyUser(s.order.buyer.id, `Order ${s.order.orderNumber}: tracking updated`, `${carrier.name}${tracking ? ` · ${tracking}` : ''}`, `/app/orders/${s.order.orderNumber}`);
  }
  await audit('order.shipment.tracking', s.order.orderNumber, `#${s.seq} ${s.carrier ?? '—'} ${s.trackingNumber ?? '—'} → ${carrier.name} ${tracking ?? '—'} · by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `Tracking of shipment ${s.seq} saved. ${mail ? mailOutcomeText(mail) : 'The shipment is already delivered, so the buyer was not emailed.'}` };
}

/**
 * Record a delivery: one shipment (staff, optional POD) or every shipment of an
 * order (the buyer's “Mark as received”). The order becomes DELIVERED once all
 * shipments are delivered and everything shipped. The buyer is emailed when
 * staff record it — not when the buyer confirms it themselves.
 */
export async function markDelivered(
  p: { orderId: string; shipmentId?: string | null; deliveredAt: Date; by: 'STAFF' | 'BUYER' | 'CARRIER_POD' },
  actor: Actor,
): Promise<Result & { orderDelivered?: boolean }> {
  await ensureSettingsLoaded();
  if (p.deliveredAt.getTime() > Date.now() + 36e5) return { ok: false, message: 'The delivery date can not be in the future.' };
  const o = await prisma.order.findUnique({ where: { id: p.orderId }, select: ORDER_SELECT });
  if (!o) return { ok: false, message: 'Order not found.' };
  const targets = o.shipments.filter((s) => !s.deliveredAt && (!p.shipmentId || s.id === p.shipmentId));
  if (!targets.length) return { ok: true, message: 'Already recorded as delivered.', orderDelivered: o.status === 'DELIVERED' };
  for (const t of targets) if (t.shippedAt && p.deliveredAt < t.shippedAt) return { ok: false, message: `Shipment ${t.seq} left on ${fmtDocDay(t.shippedAt)} — it can not be delivered before that.` };
  let orderDelivered = false;
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, o.id);
    for (const t of targets) {
      await tx.shipment.updateMany({ where: { id: t.id, deliveredAt: null }, data: { deliveredAt: p.deliveredAt, deliveredBy: p.by } });
    }
    const all = await tx.shipment.findMany({ where: { orderId: o.id }, select: { deliveredAt: true, items: { select: { orderItemId: true, qty: true } } } });
    const everythingShipped = shipProgress(goodsLines(o), all.flatMap((s) => s.items)) === 'ALL';
    if (everythingShipped && all.every((s) => s.deliveredAt)) {
      const r = await tx.order.updateMany({ where: { id: o.id, status: 'SHIPPED' }, data: { status: 'DELIVERED', deliveredAt: p.deliveredAt } });
      orderDelivered = r.count === 1;
    }
  });
  let mail: MailOutcome | null = null;
  if (p.by !== 'BUYER' && orderDelivered) {
    mail = await sendBuyerMail({
      to: o.buyer.email,
      subject: `Order ${o.orderNumber} delivered`,
      heading: 'Your order was delivered',
      text: fillTemplate(fulfilmentText('EMAIL_DELIVERED_TEXT'), { ORDER: o.orderNumber, DATE: fmtDocDay(p.deliveredAt), DAYS: returnWindowDays() }),
      cta: { href: orderUrl(o.orderNumber), label: 'View your order' },
      context: 'orders:delivered',
    });
    if (mail.ok) await prisma.shipment.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { deliveredEmailAt: new Date() } });
  }
  if (orderDelivered) {
    if (p.by !== 'BUYER') await notifyUser(o.buyer.id, `Order ${o.orderNumber}: delivered`, 'Your order was delivered.', `/app/orders/${o.orderNumber}`);
    await notifyAdmins(`Order ${o.orderNumber}: delivered${p.by === 'BUYER' ? ' (confirmed by the buyer)' : ''}`, `${targets.length} shipment(s)`, `/admin/orders/${o.id}`, 'ORDER_DELIVERED');
  }
  await audit('order.shipment.delivered', o.orderNumber, `${targets.map((t) => `#${t.seq}`).join(',')} by ${p.by} (${actor.email ?? '—'}) on ${p.deliveredAt.toISOString().slice(0, 10)}${orderDelivered ? ' · order DELIVERED' : ''}`);
  const msg = orderDelivered
    ? `Order ${o.orderNumber} is delivered.${mail ? ` ${mailOutcomeText(mail)}` : ''}`
    : `Shipment ${targets.map((t) => t.seq).join(', ')} recorded as delivered — the order is delivered once every item has shipped and arrived.`;
  return { ok: true, message: msg, orderDelivered };
}

/** Attach a proof of delivery (signed receipt / carrier POD) to a shipment. */
export async function attachPod(shipmentId: string, file: File, actor: Actor): Promise<Result> {
  await ensureSettingsLoaded();
  const s = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { id: true, seq: true, podKey: true, order: { select: { orderNumber: true } } } });
  if (!s) return { ok: false, message: 'Shipment not found.' };
  const up = await readVerifiedUpload(file, { allow: ['jpeg', 'png', 'webp', 'pdf'], maxBytes: podMaxBytes(), label: 'Proof of delivery' });
  if (!up.ok) return { ok: false, message: up.error };
  const key = `shipment-pod/${randomBytes(24).toString('hex')}.${up.upload.ext}`;
  await uploadObject(key, up.upload.buf, up.upload.mime);
  await prisma.shipment.update({ where: { id: s.id }, data: { podKey: key, podUploadedAt: new Date() } });
  await audit('order.shipment.pod', s.order.orderNumber, `#${s.seq}${s.podKey ? ' (replaced)' : ''} by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `Proof of delivery attached to shipment ${s.seq}.` };
}
