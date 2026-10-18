import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingBool } from '@/lib/settings';
import { companyCopyAddress, type EmailAttachment } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { audit, logError, notifyAdmins, notifyUser } from '@/lib/observability';
import {
  creditGrossOf,
  docContextFrom,
  documentAttachment,
  ensureLegacyDocuments,
  issueCreditNote,
  loadDocFacts,
  markDocumentSent,
  orderInvoice,
  type DocContext,
} from '@/lib/documents/issue';
import { fmtDocDay, fmtDocMoney } from '@/lib/documents/render';
import { getStripe } from '@/lib/stripe/client';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { isValidIban } from '@/lib/settings/defs';
import { orderReservedStock } from '@/lib/orders/checkout-tx';
import { quoteOrderTookStock } from '@/lib/quotes/stock';
import { financialAfterRefunds, refundCapacity, settleCredit, withoutFinalStop, type MoneyState } from '@/lib/fulfilment/rules';
import { restockOnPaidCancel } from '@/lib/fulfilment/policy';
import { mailOutcomeText, orderUrl, sendBuyerMail, sendStaffMail, type MailOutcome } from '@/lib/fulfilment/mail';
import { settingText } from './texts';
import { LIVE_REFUND_STATUSES, SENT_REFUND_STATUSES } from './held';

/**
 * THE refund / credit core. Every money correction of an order goes through
 * here — the admin “Refund / credit” form, “Cancel & refund” before shipping
 * (lib/fulfilment/cancel.ts), canceling an order on invoice terms, a return
 * (RMA) settled with money, a VAT correction that leaves an overpayment, the
 * missing credit note of an older refund — so the credit note, the refund
 * ledger, the order's money state and every message tell the same story
 * (owner rules: real-world semantics, no lying messages):
 *
 *  - The credit note credits the current INVOICE (full or part; exact VAT per
 *    rate — the document's total is what counts, it may differ by a cent from
 *    the amount typed; crediting the rest closes the invoice to the cent).
 *  - Every credit is split into the part that cancels an amount still due (no
 *    money moves, no Refund row) and the part refunded as money. The unpaid
 *    part goes first: a buyer who still owes money is not paid out while owing.
 *    Nothing received (approved on terms) → the credit note says the amount is
 *    no longer due; no Refund row, no “we will transfer” e-mail.
 *  - Money goes back through the refund ledger: REQUESTED (approved, bank
 *    transfer not sent yet) → SENT (staff record date + bank reference; only
 *    then is the buyer told the money was sent) → CONFIRMED (seen on the
 *    statement / in Stripe). Card refunds go through Stripe at once (SENT).
 *  - The order's refunded amount and money state count only money actually
 *    SENT (Order.amountRefundedCents); what can still be refunded counts every
 *    live refund (REQUESTED / SENT / CONFIRMED) — never twice.
 *  - Stock: a unit that never left goes back at most once per order (cancel /
 *    full credit before shipping, Settings → Stock & reservation); a shipped
 *    unit only comes back through a received and inspected return (RMA).
 */

export type Actor = { id: string | null; email: string | null };
export type RefundMethod = 'BANK_TRANSFER' | 'STRIPE' | 'OTHER';
type Tx = Prisma.TransactionClient;

export const METHOD_LABEL: Record<RefundMethod, string> = {
  BANK_TRANSFER: 'bank transfer',
  STRIPE: 'card refund (Stripe)',
  OTHER: 'another method (see the note)',
};

export class Refused extends Error {}

// Money held for the buyer (received minus approved / sent refunds): one rule, lib/finance/held.ts.
export { heldMoneyCents, LIVE_REFUNDS_SELECT, LIVE_REFUND_STATUSES, SENT_REFUND_STATUSES } from './held';

/** Money actually received; legacy paid orders (before the ledger) count the total. */
export function paidCentsOf(o: { amountPaidCents: number; totalCents: number; paidAt: Date | null; financialStatus: string; status: string }): number {
  if (o.amountPaidCents > 0) return o.amountPaidCents;
  const paidish = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(o.financialStatus) || (!!o.paidAt && !['INVOICED_ON_TERMS', 'OVERDUE', 'CREDIT_APPROVED'].includes(o.financialStatus));
  return paidish && o.status !== 'PENDING_PAYMENT' ? o.totalCents : 0;
}

const MONEY_SELECT = {
  id: true, orderNumber: true, status: true, financialStatus: true, totalCents: true, currency: true,
  amountPaidCents: true, amountRefundedCents: true, paidAt: true, stripePaymentIntentId: true, invoiceEmail: true,
  sourcingRequestId: true, paymentMethodManual: true, shippedAt: true,
  buyer: { select: { id: true, name: true, email: true } },
} satisfies Prisma.OrderSelect;
export type MoneyOrder = Prisma.OrderGetPayload<{ select: typeof MONEY_SELECT }>;

export interface LoadedMoney {
  order: MoneyOrder;
  state: MoneyState;
  /** The current invoice (a corrected invoice replaces a fully credited one). */
  invoice: { id: string; number: string; totalCents: number; legacy: boolean; snapshot: Prisma.JsonValue } | null;
}

/**
 * The money facts of one order. With an invoice, everything is relative to the
 * CURRENT invoice (its total and the credit notes against it) — after a
 * “credit & re-issue” correction the old, fully credited invoice no longer counts.
 */
export async function loadMoney(db: Tx | typeof prisma, orderId: string): Promise<LoadedMoney | null> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: MONEY_SELECT });
  if (!order) return null;
  const [invoice, refunds] = await Promise.all([
    orderInvoice(db, orderId),
    db.refund.findMany({ where: { orderId, status: { in: [...LIVE_REFUND_STATUSES] } }, select: { amountCents: true } }),
  ]);
  const credits = invoice
    ? await db.fiscalDocument.findMany({ where: { originalDocumentId: invoice.id, kind: 'CREDIT_NOTE' }, select: { totalCents: true } })
    : [];
  return {
    order,
    invoice: invoice ? { id: invoice.id, number: invoice.number, totalCents: invoice.totalCents, legacy: invoice.legacy, snapshot: invoice.snapshot } : null,
    state: {
      totalCents: invoice ? invoice.totalCents : order.totalCents,
      paidCents: paidCentsOf(order),
      creditedCents: -credits.reduce((a, d) => a + d.totalCents, 0),
      refundedCents: refunds.reduce((a, r) => a + r.amountCents, 0),
      invoiced: !!invoice,
    },
  };
}

const ON_TERMS = ['INVOICED_ON_TERMS', 'OVERDUE', 'PARTIALLY_PAID', 'CREDIT_APPROVED'];

/** What a refund / credit of this order can be right now (order page, previews, checks). */
export async function refundFacts(orderId: string) {
  await ensureLegacyDocuments(orderId);
  const m = await loadMoney(prisma, orderId);
  if (!m) return null;
  const cap = refundCapacity(m.state);
  const o = m.order;
  return {
    order: o,
    state: m.state,
    capacity: cap,
    invoice: m.invoice ? { id: m.invoice.id, number: m.invoice.number, totalCents: m.invoice.totalCents, legacy: m.invoice.legacy } : null,
    creditedCents: m.state.creditedCents,
    creditableCents: m.invoice ? Math.max(0, m.state.totalCents - m.state.creditedCents) : 0,
    /** Money received and not refunded or promised back yet. */
    refundableCents: cap.moneyCents,
    onTerms: ON_TERMS.includes(o.financialStatus) && (o.paymentMethodManual ?? '').toUpperCase() === 'INVOICE',
    viaStripe: !!o.stripePaymentIntentId,
    /** A part payment on an unpaid order (no invoice yet) can be given back before the order is canceled. */
    partPaidUnpaid: o.status === 'PENDING_PAYMENT' && !m.invoice && cap.moneyCents > 0,
  };
}

/** What the admin refund form needs: limits and the split preview. */
export async function refundPreview(orderId: string) {
  const m = await loadMoney(prisma, orderId);
  if (!m) return null;
  return { ...refundCapacity(m.state), state: m.state, invoiceNumber: m.invoice?.number ?? null, stripe: !!m.order.stripePaymentIntentId };
}

/** The exact credit note and money split a refund / credit of `askedCents` comes to (shown before confirming). */
export async function previewRefund(orderId: string, askedCents: number): Promise<{ ok: true; grossCents: number; netCents: number; taxCents: number; receivableCents: number; refundCents: number; invoiceNumber: string | null; viaStripe: boolean } | { ok: false; message: string }> {
  const m = await loadMoney(prisma, orderId);
  if (!m) return { ok: false, message: 'Order not found.' };
  const money = (c: number) => fmtDocMoney(c, m.order.currency);
  const cap = refundCapacity(m.state);
  if (!Number.isInteger(askedCents) || askedCents <= 0) return { ok: false, message: 'Enter an amount above 0.' };
  if (askedCents > cap.maxCents) return { ok: false, message: cap.maxCents ? `At most ${money(cap.maxCents)} can still be credited / refunded on this order.` : 'Nothing is left to credit or refund on this order.' };
  let gross = askedCents;
  let net = askedCents;
  let tax = 0;
  if (m.invoice) {
    const plan = await creditGrossOf(prisma, { id: m.invoice.id, snapshot: m.invoice.snapshot, totalCents: m.invoice.totalCents }, askedCents);
    gross = plan.grossCents;
    net = plan.netCents;
    tax = plan.taxCents;
  }
  const split = settleCredit(m.state, gross);
  if ('error' in split) return { ok: false, message: `Amount: ${split.error}` };
  return { ok: true, grossCents: gross, netCents: net, taxCents: tax, receivableCents: split.receivableCents, refundCents: split.refundCents, invoiceNumber: m.invoice?.number ?? null, viaStripe: !!m.order.stripePaymentIntentId };
}

/** Document texts / country names, loaded before a transaction (issueCreditNote needs them inside it). */
export async function refundDocContext(): Promise<DocContext> {
  return docContextFrom(await loadDocFacts());
}

/**
 * Recompute Order.amountRefundedCents (money actually sent) and the money
 * state. Every paid unit refunded → REFUNDED (a canceled order stays
 * canceled); nothing was paid and the invoice is credited in full → the sale
 * is undone (money state VOID, order CANCELED).
 */
export async function syncRefundTotals(tx: Tx, orderId: string): Promise<{ sentCents: number; financialStatus: string; status: string }> {
  const m = await loadMoney(tx, orderId);
  if (!m) throw new Refused('Order not found.');
  const sent = await tx.refund.aggregate({ where: { orderId, status: { in: [...SENT_REFUND_STATUSES] } }, _sum: { amountCents: true } });
  const sentCents = sent._sum.amountCents ?? 0;
  let next = financialAfterRefunds({ paidCents: m.state.paidCents, sentCents, totalCreditedCents: m.state.creditedCents, totalCents: m.state.totalCents, current: m.order.financialStatus });
  // An invoice credited in full leaves nothing due: an order that was part paid (on terms or
  // after a VAT correction) is no longer an open invoice — it is settled and the money received
  // is owed back through the ledger (REFUNDED once sent). Without this the credit exposure, the
  // “on invoice terms” panels and “record payment” would still treat a canceled order as open.
  const fullyCredited = m.state.invoiced && m.state.totalCents > 0 && m.state.creditedCents >= m.state.totalCents;
  if (fullyCredited && m.state.paidCents > 0 && ['PARTIALLY_PAID', 'INVOICED_ON_TERMS', 'OVERDUE', 'CREDIT_APPROVED'].includes(next)) next = 'PAID';
  const live = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(m.order.status);
  const status = next === 'REFUNDED' && live ? 'REFUNDED' : next === 'VOID' && live ? 'CANCELED' : m.order.status;
  await tx.order.update({
    where: { id: orderId },
    data: {
      // Money actually sent (a legacy “refunded” row counted at request time is corrected here).
      amountRefundedCents: sentCents,
      ...(next !== m.order.financialStatus ? { financialStatus: next as Prisma.OrderUpdateInput['financialStatus'] } : {}),
      ...(status !== m.order.status ? { status: status as 'REFUNDED' | 'CANCELED' } : {}),
    },
  });
  return { sentCents, financialStatus: next, status };
}

export interface CreditOutcome {
  creditNote: { id: string; number: string; totalCents: number } | null;
  creditNoteNote: string | null;
  refund: { id: string; status: string; amountCents: number; method: RefundMethod } | null;
  /** Credited gross (the credit note's total; without an invoice: the money refunded). */
  creditCents: number;
  receivableCents: number;
  refundCents: number;
  restocked: boolean;
}

/**
 * Inside the caller's transaction (order row locked): the exact credit, split
 * into the unpaid part and the money part, the credit note against the invoice
 * (settlement printed on it), the money refund in the ledger, the money state.
 * `stripeRefundId` = the card refund was already issued for `expectedRefundCents`.
 */
export async function creditAndRefundTx(
  tx: Tx,
  p: {
    orderId: string;
    amountCents: number;
    reason: string;
    method: RefundMethod | null;
    stripeRefundId?: string | null;
    expectedRefundCents?: number;
    returnId?: string | null;
    justification?: string | null;
    payeeIban?: string | null;
    /** Put every unit of the order back in stock (decided by the caller: never after shipping). */
    restock?: boolean;
    actor: Actor;
    ctx: DocContext;
  },
): Promise<CreditOutcome> {
  const m = await loadMoney(tx, p.orderId);
  if (!m) throw new Refused('Order not found.');
  let gross = p.amountCents;
  if (m.invoice) {
    const plan = await creditGrossOf(tx, { id: m.invoice.id, snapshot: m.invoice.snapshot, totalCents: m.invoice.totalCents }, p.amountCents);
    gross = plan.grossCents;
  }
  const split = settleCredit(m.state, gross);
  if ('error' in split) throw new Refused(`Amount: ${split.error}`);
  if (split.refundCents > 0 && !p.method) throw new Refused('Choose how the money is refunded.');
  if (p.method === 'STRIPE' && split.refundCents > 0 && !p.stripeRefundId) throw new Refused('The card refund was not issued.');
  if (p.stripeRefundId && p.expectedRefundCents !== undefined && p.expectedRefundCents !== split.refundCents) {
    throw new Refused(`The order changed meanwhile: ${fmtDocMoney(p.expectedRefundCents, m.order.currency)} was refunded to the card, but ${fmtDocMoney(split.refundCents, m.order.currency)} is due now.`);
  }
  const method = split.refundCents > 0 ? p.method : null;
  let creditNote: CreditOutcome['creditNote'] = null;
  let creditNoteNote: string | null = null;
  if (m.invoice) {
    if (settingBool('CREDIT_NOTE_AUTO_ON_REFUND')) {
      const cn = await issueCreditNote({
        orderId: p.orderId,
        amountCents: p.amountCents,
        reason: p.reason,
        refundMethod: method ? METHOD_LABEL[method] : null,
        money: { refundCents: split.refundCents, method },
        actorId: p.actor.id,
        tx,
        ctx: p.ctx,
      });
      // No refund without its credit note: a failure rolls everything back.
      if (!cn.ok) throw new Refused(cn.message);
      creditNote = { id: cn.document.id, number: cn.document.number, totalCents: cn.document.totalCents };
    } else {
      creditNoteNote = 'Credit notes on refund are switched off in Settings → Invoicing & numbering.';
    }
  } else {
    creditNoteNote = 'No invoice was issued for this order, so there is no invoice to credit (no credit note).';
  }
  let refund: CreditOutcome['refund'] = null;
  if (split.refundCents > 0 && method) {
    const viaStripe = method === 'STRIPE';
    const row = await tx.refund.create({
      data: {
        orderId: p.orderId,
        amountCents: split.refundCents,
        currency: m.order.currency,
        method,
        status: viaStripe ? 'SENT' : 'REQUESTED',
        reason: p.reason.slice(0, 300),
        creditNoteId: creditNote?.id ?? null,
        restock: !!p.restock,
        stripeRefundId: p.stripeRefundId ?? null,
        executedAt: viaStripe ? new Date() : null,
        sentById: viaStripe ? p.actor.id : null,
        returnId: p.returnId ?? null,
        overrideReason: p.justification?.slice(0, 500) ?? null,
        payeeIban: p.payeeIban ?? null,
        createdById: p.actor.id,
      },
      select: { id: true, status: true, amountCents: true },
    });
    refund = { ...row, method };
  }
  if (p.restock) {
    const items = await tx.orderItem.findMany({ where: { orderId: p.orderId }, select: { productId: true, quantity: true } });
    for (const it of items) if (it.productId) await tx.product.updateMany({ where: { id: it.productId }, data: { quantity: { increment: it.quantity } } });
  }
  await syncRefundTotals(tx, p.orderId);
  return { creditNote, creditNoteNote, refund, creditCents: creditNote ? -creditNote.totalCents : split.refundCents, ...split, restocked: !!p.restock };
}

/**
 * Money back WITHOUT a credit note, inside the caller's transaction: an
 * overpayment (more received than the order total, or a VAT correction that
 * lowered it). REQUESTED until staff mark it sent.
 */
export async function requestRefundTx(tx: Tx, p: { orderId: string; amountCents: number; currency: string; method: RefundMethod; reason: string; actorId: string | null }): Promise<string> {
  const row = await tx.refund.create({
    data: { orderId: p.orderId, amountCents: p.amountCents, currency: p.currency, method: p.method, status: 'REQUESTED', reason: p.reason.slice(0, 300), createdById: p.actorId },
    select: { id: true },
  });
  await syncRefundTotals(tx, p.orderId);
  return row.id;
}

/** Issue a card refund in Stripe (before the DB transaction; idempotent per order + key). */
export async function stripeRefund(orderId: string, paymentIntent: string, amountCents: number, key: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const stripe = getStripe();
  if (!stripe) return { ok: false, message: 'Stripe is not configured — choose bank transfer instead.' };
  try {
    const r = await stripe.refunds.create({ payment_intent: paymentIntent, amount: amountCents }, { idempotencyKey: `l2d-refund-${orderId}-${key}` });
    return { ok: true, id: r.id };
  } catch (e) {
    await logError('refunds:stripe', e);
    return { ok: false, message: `Stripe refused the card refund (${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}). Nothing was changed here.` };
  }
}

/**
 * Claim the one buyer mail of a refund (“approved” / “issued”, or “sent”): the
 * timestamp is set before the mail goes out, so a repeated call sends nothing.
 * Returns the release for a failed send (the mail may then be tried again).
 */
async function claimRefundMail(refundId: string, kind: 'requested' | 'sent', alsoSent = false): Promise<(() => Promise<void>) | null> {
  const at = new Date();
  const claim = kind === 'requested'
    ? await prisma.refund.updateMany({ where: { id: refundId, requestedEmailAt: null }, data: { requestedEmailAt: at, ...(alsoSent ? { sentEmailAt: at } : {}) } })
    : await prisma.refund.updateMany({ where: { id: refundId, sentEmailAt: null }, data: { sentEmailAt: at } });
  if (claim.count !== 1) return null;
  return async () => {
    await prisma.refund.updateMany({
      where: { id: refundId, ...(kind === 'requested' ? { requestedEmailAt: at } : { sentEmailAt: at }) },
      data: kind === 'requested' ? { requestedEmailAt: null, ...(alsoSent ? { sentEmailAt: null } : {}) } : { sentEmailAt: null },
    });
  };
}

/** Email the buyer (and the invoice address, and the billing inbox a copy) the outcome of a credit / refund — once per refund. */
export async function emailCreditOutcome(
  order: MoneyOrder,
  out: CreditOutcome,
  ctx: { kind: 'CANCEL' | 'REFUND'; reason: string; extraHtml?: string[] },
): Promise<MailOutcome> {
  // One mail per refund id: a second call for the same refund (a retried action) sends nothing.
  const release = out.refund ? await claimRefundMail(out.refund.id, 'requested', out.refund.method === 'STRIPE') : null;
  if (out.refund && !release) return { ok: true, to: order.buyer.email, already: true };
  const money = (c: number) => fmtDocMoney(c, order.currency);
  const att: { attachment: EmailAttachment | null } = out.creditNote ? await documentAttachment(out.creditNote) : { attachment: null };
  const vars = {
    AMOUNT: money(out.refund ? out.refund.amountCents : out.creditCents),
    ORDER: order.orderNumber,
    REASON: ctx.reason,
    DATE: fmtDocDay(new Date()),
    INVOICE: (await orderInvoice(prisma, order.id))?.number ?? '',
    CREDIT_NOTE: out.creditNote?.number ?? '',
  };
  const lines: string[] = [];
  if (out.refund?.method === 'STRIPE') lines.push(settingText('EMAIL_REFUND_CARD_BODY', vars, ['AMOUNT']).html);
  else if (out.refund) lines.push(settingText('EMAIL_REFUND_BANK_BODY', vars, ['AMOUNT']).html);
  if (!out.refund && out.creditNote) lines.push(settingText('EMAIL_CREDIT_NOT_PAID_BODY', { ...vars, AMOUNT: money(out.creditCents) }, ['AMOUNT', 'CREDIT_NOTE']).html);
  else if (out.refund && out.receivableCents > 0) lines.push(`The remaining ${escapeHtml(money(out.receivableCents))} of the credit note had not been paid — <strong>you no longer owe it</strong>.`);
  if (out.creditNote) lines.push(`Credit note <strong>${escapeHtml(out.creditNote.number)}</strong> ${att.attachment ? 'is attached' : 'is available on your order page'}.`);
  const heading = ctx.kind === 'CANCEL' ? `Order ${order.orderNumber} is canceled` : out.refund?.method === 'STRIPE' ? 'Your refund was issued' : out.refund ? 'Your refund was approved' : 'Your invoice was credited';
  const subject = ctx.kind === 'CANCEL'
    ? `Order ${order.orderNumber} canceled — ${out.refund ? (out.refund.method === 'STRIPE' ? `${money(out.refund.amountCents)} refunded to your card` : `refund of ${money(out.refund.amountCents)} approved, transfer not yet sent`) : 'nothing is due'}`
    : out.refund
      ? out.refund.method === 'STRIPE' ? `Refund of ${money(out.refund.amountCents)} issued — order ${order.orderNumber}` : `Refund of ${money(out.refund.amountCents)} approved — order ${order.orderNumber}`
      : `Credit note for order ${order.orderNumber} — ${money(out.receivableCents)} no longer due`;
  const mail = await sendBuyerMail({
    to: order.buyer.email,
    subject,
    heading,
    html: [
      `<p style="margin:0 0 12px;">Hi <span dir="auto">${escapeHtml(order.buyer.name || 'there')}</span>,</p>`,
      ...(ctx.kind === 'CANCEL' ? [`<p style="margin:0 0 12px;">We canceled order <strong>${escapeHtml(order.orderNumber)}</strong>. Reason: <span dir="auto">${escapeHtml(withoutFinalStop(ctx.reason))}</span>.</p>`] : [`<p style="margin:0 0 12px;">Reason: <span dir="auto">${escapeHtml(withoutFinalStop(ctx.reason))}</span>.</p>`]),
      ...lines.map((l) => `<p style="margin:0 0 12px;">${l}</p>`),
      ...(ctx.extraHtml ?? []),
    ],
    cta: { href: orderUrl(order.orderNumber), label: 'View your order' },
    attachments: att.attachment ? [att.attachment] : [],
    context: ctx.kind === 'CANCEL' ? 'orders:cancel-paid' : 'orders:refund',
  });
  if (mail.ok && out.creditNote) await markDocumentSent(out.creditNote.id);
  if (!mail.ok && release) await release();
  // Accounts payable gets the credit note too (like the invoice), and the billing inbox a copy.
  if (out.creditNote && att.attachment) {
    if (order.invoiceEmail && order.invoiceEmail.toLowerCase() !== order.buyer.email.toLowerCase()) {
      await sendBuyerMail({ to: order.invoiceEmail, subject: `Credit note ${out.creditNote.number} — order ${order.orderNumber}`, heading: `Credit note ${out.creditNote.number}`, html: [`<p style="margin:0 0 12px;">Credit note <strong>${escapeHtml(out.creditNote.number)}</strong> for order ${escapeHtml(order.orderNumber)} is attached.</p>`, ...lines.slice(0, 1).map((l) => `<p style="margin:0 0 12px;">${l}</p>`)], attachments: [att.attachment], context: 'orders:credit-note-ap' });
    }
    await sendStaffMail({
      to: companyCopyAddress(),
      subject: `[copy] Credit note ${out.creditNote.number} — order ${order.orderNumber}`,
      heading: `Credit note ${out.creditNote.number}`,
      html: [`<p style="margin:0 0 12px;">Credit note <strong>${escapeHtml(out.creditNote.number)}</strong> issued for order ${escapeHtml(order.orderNumber)} (<span dir="auto">${escapeHtml(ctx.reason)}</span>).</p>`, ...lines.slice(0, 1).map((l) => `<p style="margin:0 0 12px;">${l}</p>`)],
      attachments: [att.attachment],
      context: 'orders:credit-note-copy',
    });
  }
  return mail;
}

/** One truthful staff sentence for a credit / refund outcome. */
export function creditSummary(out: CreditOutcome, currency: string, askedCents?: number): string {
  const money = (c: number) => fmtDocMoney(c, currency);
  const parts: string[] = [];
  if (out.creditNote) {
    const cn = -out.creditNote.totalCents;
    parts.push(`Credit note ${out.creditNote.number} issued for ${money(cn)}${askedCents !== undefined && askedCents !== cn ? ` (exact VAT per rate — you asked ${money(askedCents)})` : ''}.`);
  } else if (out.creditNoteNote) parts.push(`No credit note: ${out.creditNoteNote}`);
  if (out.receivableCents > 0) parts.push(`${money(out.receivableCents)} of the unpaid invoice is canceled — no money refunded for it (nothing was paid on it).`);
  if (out.refund?.method === 'STRIPE') parts.push(`${money(out.refund.amountCents)} refunded to the card in Stripe.`);
  else if (out.refund) parts.push(`Refund of ${money(out.refund.amountCents)} recorded as REQUESTED — the transfer is NOT sent yet: send it, then “Mark refund sent” with the date and bank reference.`);
  if (out.restocked) parts.push('The unit(s) are back in stock.');
  return parts.join(' ');
}

/**
 * A refund / credit on its own (partial or full): goodwill, a price
 * adjustment, a settled return, a part payment on an unpaid order. On a
 * shipped order without a return (RMA) it needs a written justification
 * (REFUND_SHIPPED_REQUIRES_RETURN_OR_REASON); a shipped unit is never put back
 * in stock here (A10) — only before shipping, at most once per order.
 */
export async function createRefund(
  p: {
    orderId: string; amountCents: number; reason: string; method: RefundMethod | null; returnId?: string | null; justification?: string | null; payeeIban?: string | null; restock?: boolean | null;
    /** Stripe idempotency key of the card refund (default: per order + refund count + amount). A return passes its own: one card refund per RMA. */
    stripeKey?: string;
    /**
     * Runs inside the money transaction right after the order row is locked,
     * before the credit note and refund exist (e.g. the RMA claims RESOLVED):
     * throwing Refused rolls everything back and nothing is created.
     */
    inTx?: (tx: Tx) => Promise<void>;
  },
  actor: Actor,
): Promise<{ ok: true; message: string; outcome: CreditOutcome } | { ok: false; message: string }> {
  await ensureSettingsLoaded();
  const reason = p.reason.trim().slice(0, 300);
  if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters) — it is printed on the credit note and shown to the buyer.' };
  // Older invoices are frozen as issued first: no refund without its credit note.
  await ensureLegacyDocuments(p.orderId);
  const m = await loadMoney(prisma, p.orderId);
  if (!m) return { ok: false, message: 'Order not found.' };
  const o = m.order;
  const money = (c: number) => fmtDocMoney(c, o.currency);
  const cap = refundCapacity(m.state);
  if (o.status === 'PENDING_PAYMENT' && !(cap.moneyCents > 0 && !m.invoice)) {
    return { ok: false, message: `Order ${o.orderNumber} is not paid — cancel it instead (nothing to refund).` };
  }
  if (o.status === 'CANCELED' && cap.maxCents === 0) return { ok: false, message: `Order ${o.orderNumber} is canceled and nothing is left to credit or refund.` };
  const shipped = await prisma.shipment.count({ where: { orderId: p.orderId } });
  const justification = (p.justification ?? '').trim();
  if (shipped > 0 && !p.returnId && settingBool('REFUND_SHIPPED_REQUIRES_RETURN_OR_REASON') && justification.length < 10) {
    return { ok: false, message: 'Goods were shipped: settle this through a return (RMA) — or write why money is refunded without a return (at least 10 characters; it is audited).' };
  }
  let gross = p.amountCents;
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) return { ok: false, message: 'Amount: enter an amount above 0.' };
  if (p.amountCents > cap.maxCents) return { ok: false, message: cap.maxCents ? `Amount: at most ${money(cap.maxCents)} can still be credited / refunded on this order.` : `Nothing is left to credit or refund on order ${o.orderNumber}.` };
  if (m.invoice) gross = (await creditGrossOf(prisma, { id: m.invoice.id, snapshot: m.invoice.snapshot, totalCents: m.invoice.totalCents }, p.amountCents)).grossCents;
  const split = settleCredit(m.state, gross);
  if ('error' in split) return { ok: false, message: `Amount: ${split.error}` };
  if (split.refundCents > 0 && !p.method) return { ok: false, message: 'Choose how the money is refunded.' };
  if (split.refundCents > 0 && p.method === 'STRIPE' && !o.stripePaymentIntentId) return { ok: false, message: 'This order was not paid by card — refund by bank transfer.' };
  const iban = (p.payeeIban ?? '').replace(/\s+/g, '').toUpperCase() || null;
  if (iban && !isValidIban(iban)) return { ok: false, message: 'The buyer’s IBAN is not valid — check it (or leave it empty and add it when you send the transfer).' };

  // Stock: only a unit that never left (nothing shipped), at most once per order.
  const fullCredit = m.invoice ? gross >= m.state.totalCents - m.state.creditedCents : split.refundCents >= cap.moneyCents;
  const tookStock = orderReservedStock(o) || (!!o.sourcingRequestId && (await quoteOrderTookStock(o.id)));
  const alreadyRestocked = (await prisma.refund.count({ where: { orderId: o.id, restock: true } })) > 0
    || (await prisma.returnRequest.count({ where: { orderId: o.id, restockedQty: { gt: 0 } } })) > 0;
  const canRestock = shipped === 0 && !o.shippedAt && tookStock && !alreadyRestocked && ['PAID', 'PROCESSING', 'REFUNDED'].includes(o.status);
  const restock = canRestock && (p.restock ?? (fullCredit && restockOnPaidCancel()));
  const stockNote = restock || !tookStock || !(p.restock || fullCredit)
    ? ''
    : shipped > 0 || o.shippedAt ? ' Stock NOT returned: the goods were shipped — they come back to stock when the return is received and inspected (“resell”).'
      : alreadyRestocked ? ' Stock was already returned earlier — not returned twice.'
        : o.status === 'PENDING_PAYMENT' ? '' : ' Stock NOT returned (Settings → Stock & reservation, or unticked) — put it back by hand after checking the unit.';

  let stripeId: string | null = null;
  if (p.method === 'STRIPE' && split.refundCents > 0) {
    const n = await prisma.refund.count({ where: { orderId: p.orderId } });
    const s = await stripeRefund(p.orderId, o.stripePaymentIntentId as string, split.refundCents, p.stripeKey ?? `r${n + 1}-${split.refundCents}`);
    if (!s.ok) return { ok: false, message: s.message };
    stripeId = s.id;
  }
  const docCtx = await refundDocContext();
  let out: CreditOutcome;
  try {
    out = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${p.orderId} FOR UPDATE`;
      if (p.inTx) await p.inTx(tx);
      return creditAndRefundTx(tx, { orderId: p.orderId, amountCents: p.amountCents, reason, method: p.method, stripeRefundId: stripeId, expectedRefundCents: stripeId ? split.refundCents : undefined, returnId: p.returnId, justification: justification || null, payeeIban: iban, restock, actor, ctx: docCtx });
    });
  } catch (e) {
    if (e instanceof Refused) {
      if (!stripeId) return { ok: false, message: e.message };
      // Same idempotency key (e.g. the same return resolved twice): Stripe returned the card refund the
      // first request already booked — nothing went back twice.
      const booked = await prisma.refund.findFirst({ where: { stripeRefundId: stripeId }, select: { id: true } });
      return { ok: false, message: booked ? `${e.message} The card refund ${stripeId} is the one already recorded on this order — nothing was refunded twice.` : `The card refund WAS issued in Stripe (${stripeId}) but could not be recorded: ${e.message} Do not refund again — record it by hand.` };
    }
    await logError('refunds:credit', e);
    return { ok: false, message: stripeId ? `The card refund WAS issued in Stripe (${stripeId}) but recording it failed — do not refund again; contact a developer.` : `Nothing was changed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}` };
  }
  const mail = await emailCreditOutcome(o, out, { kind: 'REFUND', reason });
  await notifyUser(o.buyer.id, out.refund ? (out.refund.method === 'STRIPE' ? `Refund issued — order ${o.orderNumber}` : `Refund approved — order ${o.orderNumber}`) : `Credit note — order ${o.orderNumber}`, out.refund && out.refund.method !== 'STRIPE' ? 'The transfer has not been sent yet — we email you when it is.' : 'See your order page.', `/app/orders/${o.orderNumber}`);
  await notifyAdmins(`Order ${o.orderNumber}: refund / credit ${money(out.creditCents)}`, `${creditSummary(out, o.currency)} By ${actor.email ?? 'staff'}. Reason: ${reason}`.slice(0, 300), `/admin/orders/${p.orderId}`, 'ORDER_REFUNDED');
  await audit('order.refund', o.orderNumber, `asked ${p.amountCents} credit ${out.creditCents} ${o.currency} · receivable ${out.receivableCents} · money ${out.refundCents} ${p.method ?? ''}${stripeId ? ` ${stripeId}` : ''} · cn=${out.creditNote?.number ?? 'none'} · rma=${p.returnId ?? '-'} · restock=${out.restocked} · by ${actor.email ?? 'staff'} · reason="${reason.slice(0, 80)}"${justification ? ` · justification="${justification.slice(0, 120)}"` : ''}`);
  const partPaid = o.status === 'PENDING_PAYMENT' ? ' The order is still open (unpaid): cancel it now if the deal is off, or the buyer pays the full amount.' : '';
  return { ok: true, message: `${creditSummary(out, o.currency, m.invoice ? p.amountCents : undefined)}${stockNote}${partPaid} ${mailOutcomeText(mail)}`, outcome: out };
}

/**
 * An order refunded without a credit note (older refunds, before credit notes
 * existed): issue the missing one for what is left on the invoice. The money
 * already went back, so the credit note says it WAS refunded — nothing new is
 * refunded and no Refund row is added.
 */
export async function issueMissingCreditNote(orderId: string, reasonRaw: string, actor: Actor): Promise<{ ok: boolean; message: string; creditNote?: { id: string; number: string; totalCents: number } }> {
  await ensureSettingsLoaded();
  const reason = reasonRaw.trim().slice(0, 300);
  if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters) — it is printed on the credit note.' };
  const f = await refundFacts(orderId);
  if (!f) return { ok: false, message: 'Order not found.' };
  if (f.order.status !== 'REFUNDED') return { ok: false, message: 'Only a refunded order can get a credit note for an earlier refund — use “Refund / credit” for a new one.' };
  if (!f.invoice) return { ok: false, message: 'This order has no invoice, so no credit note is needed.' };
  if (f.creditableCents <= 0) return { ok: false, message: `Invoice ${f.invoice.number} is already credited in full.` };
  const cn = await issueCreditNote({ orderId, amountCents: f.creditableCents, reason, refundMethod: null, money: { refundCents: f.creditableCents, method: null, alreadyRefunded: true }, actorId: actor.id });
  if (!cn.ok) return { ok: false, message: cn.message };
  const att = await documentAttachment(cn.document);
  await audit('order.creditnote.missing', f.order.orderNumber, `${cn.document.number} for ${-cn.document.totalCents} by ${actor.email ?? 'staff'}: ${reason}`);
  await notifyAdmins(`Order ${f.order.orderNumber}: credit note ${cn.document.number} issued for an earlier refund`, `By ${actor.email ?? 'staff'}. ${reason}`, `/admin/orders/${orderId}`, 'SYSTEM');
  return {
    ok: true,
    message: `Credit note ${cn.document.number} issued for the earlier refund (${fmtDocMoney(-cn.document.totalCents, f.order.currency)}); it says the amount was refunded. ${att.attachment ? 'Download it from the documents list and send it to the buyer if they need it.' : 'Its PDF is rendered on first download.'}`,
    creditNote: { id: cn.document.id, number: cn.document.number, totalCents: cn.document.totalCents },
  };
}

/** REQUESTED → SENT: staff record the transfer (date + bank reference, optional IBAN / proof). The buyer is told now — not before. */
export async function markRefundSent(
  p: { refundId: string; sentAt: Date; bankRef: string; payeeIban?: string | null; proof?: File | null },
  actor: Actor,
): Promise<{ ok: boolean; message: string }> {
  await ensureSettingsLoaded();
  const bankRef = p.bankRef.trim().slice(0, 80);
  if (bankRef.length < 3) return { ok: false, message: 'Enter the bank reference of the transfer (as on your bank statement).' };
  if (p.sentAt.getTime() > Date.now() + 36e5) return { ok: false, message: 'The transfer date can not be in the future.' };
  const r = await prisma.refund.findUnique({ where: { id: p.refundId }, select: { id: true, status: true, amountCents: true, currency: true, method: true, createdAt: true, orderId: true, payeeIban: true } });
  if (!r) return { ok: false, message: 'Refund not found.' };
  if (r.status !== 'REQUESTED') return { ok: false, message: `This refund is already ${r.status.toLowerCase()}.` };
  if (p.sentAt.getTime() < r.createdAt.getTime() - 86_400_000) return { ok: false, message: 'The transfer date is before the refund was recorded — check the date.' };
  const iban = (p.payeeIban ?? '').replace(/\s+/g, '').toUpperCase() || r.payeeIban;
  if (iban && !isValidIban(iban)) return { ok: false, message: 'The IBAN is not valid — check it.' };
  let proofKey: string | null = null;
  if (p.proof && p.proof.size > 0) {
    const up = await readVerifiedUpload(p.proof, { allow: ['jpeg', 'png', 'webp', 'pdf'], maxBytes: 10 * 1024 * 1024, label: 'Transfer proof' });
    if (!up.ok) return { ok: false, message: up.error };
    proofKey = `refund-proofs/${randomBytes(24).toString('hex')}.${up.upload.ext}`;
    await uploadObject(proofKey, up.upload.buf, up.upload.mime);
  }
  let totals: { sentCents: number; financialStatus: string };
  try {
    totals = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${r.orderId} FOR UPDATE`;
      const claim = await tx.refund.updateMany({
        where: { id: r.id, status: 'REQUESTED' },
        data: { status: 'SENT', executedAt: p.sentAt, bankRef, sentById: actor.id, ...(iban ? { payeeIban: iban } : {}), ...(proofKey ? { proofKey } : {}) },
      });
      if (claim.count !== 1) throw new Refused('Someone else recorded this refund a moment ago — reload.');
      return syncRefundTotals(tx, r.orderId);
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, message: e.message };
    throw e;
  }
  const o = await prisma.order.findUnique({ where: { id: r.orderId }, select: { orderNumber: true, buyer: { select: { id: true, name: true, email: true } } } });
  if (!o) return { ok: true, message: 'Refund recorded as sent.' };
  const amount = fmtDocMoney(r.amountCents, r.currency);
  const t = settingText('EMAIL_REFUND_SENT_BODY', { AMOUNT: amount, ORDER: o.orderNumber, DATE: fmtDocDay(p.sentAt), REFERENCE: bankRef }, ['AMOUNT']);
  // One “refund sent” mail per refund.
  const release = await claimRefundMail(r.id, 'sent');
  const mail: MailOutcome = !release ? { ok: true, to: o.buyer.email, already: true } : await sendBuyerMail({
    to: o.buyer.email,
    subject: `Refund of ${amount} sent — order ${o.orderNumber}`,
    heading: 'Your refund was sent',
    html: [`<p style="margin:0 0 12px;">Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,</p>`, `<p style="margin:0 0 12px;">${t.html}</p>`],
    cta: { href: orderUrl(o.orderNumber), label: 'View your order' },
    context: 'orders:refund-sent',
  });
  if (!mail.ok && release) await release();
  await notifyUser(o.buyer.id, `Refund sent — order ${o.orderNumber}`, `${amount} sent on ${fmtDocDay(p.sentAt)} (reference ${bankRef}).`, `/app/orders/${o.orderNumber}`);
  await audit('order.refund.sent', o.orderNumber, `${r.amountCents} ${r.currency} on ${p.sentAt.toISOString().slice(0, 10)} ref ${bankRef}${proofKey ? ' +proof' : ''} · by ${actor.email ?? 'staff'} · money state ${totals.financialStatus}`);
  return { ok: true, message: `Refund of ${amount} recorded as sent on ${fmtDocDay(p.sentAt)} (reference ${bankRef}). ${mailOutcomeText(mail)}` };
}

/** SENT → CONFIRMED: the money demonstrably left (bank statement / Stripe). Internal; no buyer email. */
export async function confirmRefund(refundId: string, actor: Actor): Promise<{ ok: boolean; message: string }> {
  const r = await prisma.refund.findUnique({ where: { id: refundId }, select: { id: true, status: true, amountCents: true, currency: true, order: { select: { orderNumber: true } } } });
  if (!r) return { ok: false, message: 'Refund not found.' };
  if (r.status !== 'SENT') return { ok: false, message: r.status === 'REQUESTED' ? 'Record the transfer as sent first.' : `This refund is already ${r.status.toLowerCase()}.` };
  const claim = await prisma.refund.updateMany({ where: { id: r.id, status: 'SENT' }, data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedById: actor.id } });
  if (claim.count !== 1) return { ok: false, message: 'Someone else changed this refund — reload.' };
  await audit('order.refund.confirmed', r.order.orderNumber, `${r.amountCents} ${r.currency} by ${actor.email ?? 'staff'}`);
  return { ok: true, message: `Refund of ${fmtDocMoney(r.amountCents, r.currency)} confirmed (seen on the bank statement / in Stripe).` };
}

/** Stripe charge.refunded: card refunds we issued are confirmed once Stripe reports the amount. */
export async function confirmStripeRefunds(orderId: string, stripeRefundedCents: number): Promise<number> {
  const sent = await prisma.refund.findMany({ where: { orderId, method: 'STRIPE', status: 'SENT' }, orderBy: { createdAt: 'asc' }, select: { id: true, amountCents: true } });
  const confirmedBefore = await prisma.refund.aggregate({ where: { orderId, method: 'STRIPE', status: 'CONFIRMED' }, _sum: { amountCents: true } });
  let budget = stripeRefundedCents - (confirmedBefore._sum.amountCents ?? 0);
  let n = 0;
  for (const r of sent) {
    if (r.amountCents > budget) break;
    const c = await prisma.refund.updateMany({ where: { id: r.id, status: 'SENT' }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });
    if (c.count === 1) { n++; budget -= r.amountCents; }
  }
  return n;
}
