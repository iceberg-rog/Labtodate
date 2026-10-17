'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { attachPod, markDelivered, markOrderProcessing, recordShipment, updateShipmentTracking } from '@/lib/fulfilment/shipments';
import { cancelPaidOrder, cancelUnpaidOrder } from '@/lib/fulfilment/cancel';
import { confirmRefund, createRefund, markRefundSent, type RefundMethod } from '@/lib/finance/refunds';
import {
  approveReturn,
  createReturnRequest,
  inspectReturn,
  receiveReturn,
  rejectReturn,
  resolveReturn,
  type ReturnOutcome,
} from '@/lib/fulfilment/returns';

/**
 * Staff actions for fulfilment, cancellation, returns and refunds. Each checks
 * its capability (orders:fulfil for shipping / returns, orders:refund for money
 * and for canceling a paid order) and returns the truthful outcome.
 */

type R = { ok: boolean; message: string };

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
/** "1.234,56" / "1234.56" / "€ 99" → cents; null when empty, NaN when not a number. */
const euros = (v: string): number | null => {
  if (!v) return null;
  const raw = v.replace(/[€\s]/g, '');
  const norm = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  const n = Number(norm);
  return Number.isFinite(n) && norm !== '' ? Math.round(n * 100) : NaN;
};
/** A date input (YYYY-MM-DD): today → now, other days → 12:00 UTC (no time-zone drift). */
function dateInput(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const today = new Date().toISOString().slice(0, 10);
  return v === today ? new Date() : new Date(`${v}T12:00:00Z`);
}
const METHODS: RefundMethod[] = ['BANK_TRANSFER', 'STRIPE', 'OTHER'];
const method = (v: string): RefundMethod | null => (METHODS.includes(v as RefundMethod) ? (v as RefundMethod) : null);

async function refresh(orderId: string) {
  revalidatePath('/admin/orders');
  revalidatePath('/admin/orders/returns');
  revalidatePath(`/admin/orders/${orderId}`);
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true, sourcingRequestId: true } });
  if (o) {
    revalidatePath(`/app/orders/${o.orderNumber}`);
    if (o.sourcingRequestId) revalidatePath(`/admin/quotes/${o.sourcingRequestId}`);
  }
}

async function orderOfReturn(returnId: string) {
  return (await prisma.returnRequest.findUnique({ where: { id: returnId }, select: { orderId: true } }))?.orderId ?? null;
}

// ── shipping ────────────────────────────────────────────────────────────────

export async function markProcessingAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const orderId = str(fd, 'orderId');
  const r = await markOrderProcessing(orderId, { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return r;
}

export async function recordShipmentAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  await ensureSettingsLoaded();
  const orderId = str(fd, 'orderId');
  const lines: Array<{ orderItemId: string; qty: number }> = [];
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('qty_')) {
      const n = Number(String(v).trim() || '0');
      lines.push({ orderItemId: k.slice(4), qty: Number.isFinite(n) ? n : NaN });
    }
  }
  if (lines.some((l) => !Number.isInteger(l.qty) || l.qty < 0)) return { ok: false, message: 'Quantities must be whole numbers (0 or more).' };
  const shippedAt = dateInput(str(fd, 'shippedAt')) ?? new Date();
  const insured = euros(str(fd, 'insuredValue'));
  if (Number.isNaN(insured)) return { ok: false, message: 'Insured value must be an amount, e.g. 1250.00.' };
  const kg = str(fd, 'grossKg');
  const grossKg = kg ? Number(kg.replace(',', '.')) : null;
  if (grossKg !== null && !Number.isFinite(grossKg)) return { ok: false, message: 'Gross weight must be a number of kg.' };
  const r = await recordShipment({
    orderId,
    lines: lines.length ? lines : 'ALL',
    carrier: str(fd, 'carrier'),
    trackingNumber: str(fd, 'trackingNumber') || null,
    parcels: Number(str(fd, 'parcels') || '1'),
    grossKg,
    // Empty = the goods value of exactly the lines shipped (when Settings insure by default).
    insuredValueCents: str(fd, 'notInsured') === 'on' ? null : insured == null ? 'DEFAULT' : insured,
    shippedAt,
    note: str(fd, 'note').slice(0, 500) || null,
  }, { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return { ok: r.ok, message: r.message };
}

export async function updateTrackingAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const shipmentId = str(fd, 'shipmentId');
  const r = await updateShipmentTracking({ shipmentId, carrier: str(fd, 'carrier'), trackingNumber: str(fd, 'trackingNumber') || null }, { id: s.user.id, email: s.user.email });
  const sh = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } });
  if (sh) await refresh(sh.orderId);
  return r;
}

export async function markDeliveredAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const orderId = str(fd, 'orderId');
  const deliveredAt = dateInput(str(fd, 'deliveredAt')) ?? new Date();
  const r = await markDelivered({ orderId, shipmentId: str(fd, 'shipmentId') || null, deliveredAt, by: fd.get('pod') ? 'CARRIER_POD' : 'STAFF' }, { id: s.user.id, email: s.user.email });
  const pod = fd.get('pod');
  let podMsg = '';
  if (r.ok && pod && typeof pod !== 'string' && pod.size > 0 && str(fd, 'shipmentId')) {
    const p = await attachPod(str(fd, 'shipmentId'), pod, { id: s.user.id, email: s.user.email });
    podMsg = ` ${p.message}`;
  }
  await refresh(orderId);
  return { ok: r.ok, message: `${r.message}${podMsg}` };
}

export async function uploadPodAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const shipmentId = str(fd, 'shipmentId');
  const file = fd.get('pod');
  if (!file || typeof file === 'string' || file.size === 0) return { ok: false, message: 'Choose the proof-of-delivery file.' };
  const r = await attachPod(shipmentId, file, { id: s.user.id, email: s.user.email });
  const sh = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } });
  if (sh) await refresh(sh.orderId);
  return r;
}

/** Bulk ship: one row per order with its own carrier + tracking number. */
export async function bulkShipAction(fd: FormData): Promise<R & { shipped: number }> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  let rows: Array<{ orderId: string; carrier: string; tracking: string }> = [];
  try {
    rows = JSON.parse(str(fd, 'rows'));
  } catch {
    return { ok: false, shipped: 0, message: 'Nothing to ship.' };
  }
  if (!Array.isArray(rows) || !rows.length) return { ok: false, shipped: 0, message: 'Nothing to ship.' };
  const results: string[] = [];
  let shipped = 0;
  for (const row of rows.slice(0, 100)) {
    const o = await prisma.order.findUnique({ where: { id: String(row.orderId) }, select: { orderNumber: true } });
    const r = await recordShipment({
      orderId: String(row.orderId), lines: 'ALL', carrier: String(row.carrier ?? ''), trackingNumber: String(row.tracking ?? '').trim() || null,
      parcels: 1, grossKg: null, insuredValueCents: 'DEFAULT', shippedAt: new Date(), note: 'Bulk shipping from the orders list.',
    }, { id: s.user.id, email: s.user.email });
    if (r.ok) shipped++;
    results.push(r.ok ? `✓ ${r.message}` : `✗ ${o?.orderNumber ?? row.orderId}: ${r.message}`);
  }
  revalidatePath('/admin/orders');
  revalidatePath('/admin');
  return { ok: shipped > 0, shipped, message: `${shipped} of ${rows.length} shipped. ${results.join(' ')}` };
}

// ── cancellation ────────────────────────────────────────────────────────────

export async function cancelOrderAction(fd: FormData): Promise<R> {
  const orderId = str(fd, 'orderId');
  const reasonSel = str(fd, 'reason');
  const other = str(fd, 'reasonOther');
  const reason = reasonSel === 'Other' ? other : [reasonSel, other].filter(Boolean).join(' — ');
  const note = str(fd, 'note') || null;
  if (reason.length < 3) return { ok: false, message: 'Choose the reason — it goes to the buyer.' };
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.status === 'PENDING_PAYMENT') {
    const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
    const r = await cancelUnpaidOrder(orderId, { kind: 'STAFF', id: s.user.id, email: s.user.email }, { reason, note });
    await refresh(orderId);
    return r;
  }
  const s = await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  const r = await cancelPaidOrder({ orderId, reason, note, method: method(str(fd, 'method')), payeeIban: str(fd, 'payeeIban') || null }, { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return r;
}

// ── refunds ─────────────────────────────────────────────────────────────────

export async function createRefundAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  const orderId = str(fd, 'orderId');
  const amount = euros(str(fd, 'amount'));
  if (amount == null || Number.isNaN(amount)) return { ok: false, message: 'Enter the amount (incl. VAT), e.g. 250.00.' };
  const reasonSel = str(fd, 'reason');
  const reason = reasonSel === 'Other' ? str(fd, 'reasonOther') || '' : [reasonSel, str(fd, 'reasonOther')].filter(Boolean).join(' — ');
  const restockRaw = str(fd, 'restock');
  const r = await createRefund({
    orderId, amountCents: amount, reason, method: method(str(fd, 'method')), justification: str(fd, 'justification') || null, payeeIban: str(fd, 'payeeIban') || null,
    // Only offered before anything shipped (the form hides it otherwise); null = Settings default.
    restock: restockRaw === 'on' ? true : restockRaw === 'off' ? false : null,
  }, { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return { ok: r.ok, message: r.message };
}

export async function markRefundSentAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  const refundId = str(fd, 'refundId');
  const sentAt = dateInput(str(fd, 'sentAt'));
  if (!sentAt) return { ok: false, message: 'Enter the date the transfer was sent.' };
  const proof = fd.get('proof');
  const r = await markRefundSent({ refundId, sentAt, bankRef: str(fd, 'bankRef'), payeeIban: str(fd, 'payeeIban') || null, proof: proof && typeof proof !== 'string' ? proof : null }, { id: s.user.id, email: s.user.email });
  const row = await prisma.refund.findUnique({ where: { id: refundId }, select: { orderId: true } });
  if (row) await refresh(row.orderId);
  return r;
}

export async function confirmRefundAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:refund', { redirectTo: '/admin/orders' });
  const refundId = str(fd, 'refundId');
  const r = await confirmRefund(refundId, { id: s.user.id, email: s.user.email });
  const row = await prisma.refund.findUnique({ where: { id: refundId }, select: { orderId: true } });
  if (row) await refresh(row.orderId);
  return r;
}

// ── returns (RMA) ───────────────────────────────────────────────────────────

export async function openReturnAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const orderId = str(fd, 'orderId');
  const lines: Array<{ orderItemId: string; qty: number }> = [];
  for (const [k, v] of fd.entries()) if (k.startsWith('rqty_')) lines.push({ orderItemId: k.slice(5), qty: Number(String(v) || '0') });
  const files = fd.getAll('files').filter((f): f is File => typeof f !== 'string');
  const r = await createReturnRequest({ orderId, reasonLabel: str(fd, 'reason'), description: str(fd, 'description'), lines, files, openedBy: 'STAFF' }, { id: s.user.id, email: s.user.email });
  await refresh(orderId);
  return r;
}

export async function approveReturnAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const returnId = str(fd, 'returnId');
  const label = fd.get('label');
  const r = await approveReturn({ returnId, instructions: str(fd, 'instructions'), noReturnNeeded: str(fd, 'noReturnNeeded') === 'on', label: label && typeof label !== 'string' ? label : null }, { id: s.user.id, email: s.user.email });
  const orderId = await orderOfReturn(returnId);
  if (orderId) await refresh(orderId);
  return r;
}

export async function rejectReturnAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const returnId = str(fd, 'returnId');
  const r = await rejectReturn({ returnId, reason: str(fd, 'reason') }, { id: s.user.id, email: s.user.email });
  const orderId = await orderOfReturn(returnId);
  if (orderId) await refresh(orderId);
  return r;
}

export async function receiveReturnAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const returnId = str(fd, 'returnId');
  const r = await receiveReturn({ returnId, receivedAt: dateInput(str(fd, 'receivedAt')) ?? new Date(), note: str(fd, 'note') || null }, { id: s.user.id, email: s.user.email });
  const orderId = await orderOfReturn(returnId);
  if (orderId) await refresh(orderId);
  return r;
}

export async function inspectReturnAction(fd: FormData): Promise<R> {
  const s = await requireCapability('orders:fulfil', { redirectTo: '/admin/orders' });
  const returnId = str(fd, 'returnId');
  const grade = str(fd, 'grade') as 'RESELL' | 'REFURBISH' | 'SCRAP';
  if (!['RESELL', 'REFURBISH', 'SCRAP'].includes(grade)) return { ok: false, message: 'Choose the grade.' };
  const r = await inspectReturn({ returnId, grade, note: str(fd, 'note'), restock: str(fd, 'restock') === 'on' }, { id: s.user.id, email: s.user.email });
  const orderId = await orderOfReturn(returnId);
  if (orderId) await refresh(orderId);
  return r;
}

const OUTCOMES: ReturnOutcome[] = ['FULL_REFUND', 'PARTIAL_REFUND', 'CREDIT', 'REPLACEMENT', 'REPAIR', 'NONE'];

export async function resolveReturnAction(fd: FormData): Promise<R> {
  const outcome = str(fd, 'outcome') as ReturnOutcome;
  if (!OUTCOMES.includes(outcome)) return { ok: false, message: 'Choose the outcome.' };
  const money = outcome === 'FULL_REFUND' || outcome === 'PARTIAL_REFUND' || outcome === 'CREDIT';
  const s = await requireCapability(money ? 'orders:refund' : 'orders:fulfil', { redirectTo: '/admin/orders' });
  const amount = euros(str(fd, 'amount'));
  if (money && (amount == null || Number.isNaN(amount))) return { ok: false, message: 'Enter the amount (incl. VAT).' };
  const returnId = str(fd, 'returnId');
  const r = await resolveReturn({ returnId, outcome, amountCents: money ? amount : null, method: method(str(fd, 'method')), note: str(fd, 'note') }, { id: s.user.id, email: s.user.email });
  const orderId = await orderOfReturn(returnId);
  if (orderId) await refresh(orderId);
  return r;
}
