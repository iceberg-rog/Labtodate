'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requireCapability, requireSession } from '@/lib/auth-server';
import { approveAddressChange, clearComplianceHold, recheckOrderVat, releaseHold, setOrderFreight } from '@/lib/checkout/holds';

/**
 * Staff resolution of an order's pre-payment holds (checkout & pricing).
 * Every action returns { ok, message } — shown next to the button — and is
 * audited in lib/checkout/holds.ts.
 */

type R = { ok: boolean; message: string };

async function actor(cap: string) {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCapability(cap, { redirectTo: '/admin' });
  return { id: session.user.id, email: session.user.email };
}

function done(orderId: string, r: R): R {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath('/admin/orders');
  return r;
}

async function orderNumberOf(id: string) {
  const o = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } });
  if (o) revalidatePath(`/app/orders/${o.orderNumber}`);
}

export async function setFreightAction(formData: FormData): Promise<R> {
  const a = await actor('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const raw = String(formData.get('amount') ?? '').replace(/[€\s]/g, '').replace(',', '.');
  const note = String(formData.get('note') ?? '').trim().slice(0, 300);
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, message: 'Enter the shipping cost in euros, e.g. 185 or 185.50.' };
  if (note.length < 3) return { ok: false, message: 'Say where the price comes from (carrier / quote reference) — it is kept with the order.' };
  const r = await setOrderFreight(id, Math.round(Number(raw) * 100), a, note);
  await orderNumberOf(id);
  return done(id, r);
}

export async function recheckVatAction(formData: FormData): Promise<R> {
  const a = await actor('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const r = await recheckOrderVat(id, a);
  await orderNumberOf(id);
  return done(id, r);
}

export async function clearComplianceAction(formData: FormData): Promise<R> {
  const a = await actor('compliance:clear');
  const id = String(formData.get('orderId') ?? '');
  const r = await clearComplianceHold(id, a, String(formData.get('note') ?? ''));
  await orderNumberOf(id);
  return done(id, r);
}

export async function approveAddressAction(formData: FormData): Promise<R> {
  const a = await actor('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 300) || 'approved';
  const r = await approveAddressChange(id, a, note);
  await orderNumberOf(id);
  return done(id, r);
}

/** Payment review (Stripe mismatch / dispute): release after it was sorted out in Stripe. */
export async function releasePaymentReviewAction(formData: FormData): Promise<R> {
  const a = await actor('orders:refund');
  const id = String(formData.get('orderId') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  if (note.length < 4) return { ok: false, message: 'Write down how the payment was resolved (refund, corrected amount…).' };
  const r = await releaseHold(id, 'PAYMENT_REVIEW', a, note.slice(0, 300));
  await orderNumberOf(id);
  return done(id, r);
}
