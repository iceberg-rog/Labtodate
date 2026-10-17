'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireSession } from '@/lib/auth-server';
import { uploadObject } from '@/lib/storage/s3';
import { audit, notifyAdmins } from '@/lib/observability';
import { evaluateAddressChange, hasPrePaymentHold, recordAddressChange } from '@/lib/checkout/holds';
import { ensureSettingsLoaded } from '@/lib/settings';
import { sendInternalEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { formatPrice } from '@/lib/utils';
import { orderDetailsProblems, parseDetailsInput, type DetailsFieldErrors } from '@/lib/orders/details';
import { saveOrderDetails } from '@/lib/orders/details-server';
import { effectiveDueDate, duePhase } from '@/lib/orders/payment-due';
import { autoCancelUnpaid, buyerCanCancelUnpaid, cancelReasons, paymentGraceDays, paymentTermDays, requireDetailsBeforePayment, vatIdRule } from '@/lib/quotes/policy';
import { cancelUnpaidOrder } from '@/lib/fulfilment/cancel';
import { creditStatusFor } from '@/lib/credit/terms';
import { mailLayout, siteBase } from '@/lib/quotes/mail';

const ALLOWED_METHODS = ['BANK_TRANSFER', 'OTHER'] as const;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;

export type PaymentActionResult = { error?: string; notice?: string; warning?: string; fieldErrors?: DetailsFieldErrors };

async function loadOwnOrder(orderNumber: string, userId: string) {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: { include: { product: { select: { vatScheme: true } } }, orderBy: { id: 'asc' } },
      sourcingRequest: { select: { id: true, status: true, validUntilAt: true } },
    },
  });
  if (!order || order.buyerId !== userId) return null;
  return order;
}

/**
 * Buyer-side: upload the payment receipt. Requires the billing + delivery
 * details on the order first (REQUIRE_DETAILS_BEFORE_PAYMENT, owner report 5),
 * refuses a canceled / lapsed / on-hold order. Moves the order into
 * AWAITING_VERIFICATION; staff then verify or reject it.
 */
export async function buyerSubmitPaymentProof(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  await ensureSettingsLoaded();
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  if (!orderNumber) redirect('/app/orders');
  const order = await loadOwnOrder(orderNumber, session.user.id);
  if (!order) redirect('/app/orders');

  // Only PENDING_PAYMENT orders accept proof. AWAITING_VERIFICATION can be
  // replaced (buyer corrects a wrong file before admin reviews).
  if (order.status !== 'PENDING_PAYMENT') {
    redirect(`/app/orders/${orderNumber}/payment?err=${order.status === 'CANCELED' ? 'canceled' : 'closed'}`);
  }
  const sr = order.sourcingRequest;
  // An order the old flow auto-created before the buyer accepted the offer is
  // not payable until they accept it.
  if (sr?.status === 'RESPONDED') redirect(`/app/orders/${orderNumber}/payment?err=notaccepted`);
  if (sr && (sr.status === 'DECLINED' || sr.status === 'CLOSED')) redirect(`/app/orders/${orderNumber}/payment?err=canceled`);
  // Any pre-payment hold (shipping / VAT / compliance / address — the total is not
  // final yet, lib/checkout/holds.ts) or a payment under review: no receipt yet.
  if (hasPrePaymentHold(order) || order.holdReason === 'PAYMENT_REVIEW' || order.openHolds.includes('PAYMENT_REVIEW')) {
    redirect(`/app/orders/${orderNumber}/payment?err=hold`);
  }
  if (order.paymentVerificationStatus === 'TERMS_REQUESTED') redirect(`/app/orders/${orderNumber}/payment?err=terms`);
  // Past due date + grace (auto-cancel on): the sweep cancels it — refuse now too.
  const due = effectiveDueDate({ dueAt: order.dueAt, createdAt: order.createdAt, payableSince: order.payableSince, legacyValidUntil: sr?.validUntilAt ?? null }, paymentTermDays());
  if (autoCancelUnpaid() && duePhase(new Date(), due, paymentGraceDays()) === 'CANCEL_DUE' && !order.paymentSubmittedAt) {
    redirect(`/app/orders/${orderNumber}/payment?err=expired`);
  }
  if (requireDetailsBeforePayment() && orderDetailsProblems(order, { vatIdRule: vatIdRule() }).length) {
    redirect(`/app/orders/${orderNumber}/payment?err=details`);
  }

  const get = (k: string) => String(formData.get(k) ?? '').trim();
  const method = get('method').toUpperCase();
  const rawNote = get('note').slice(0, 500);
  const bankRef = get('bank_ref').slice(0, 60);
  const noteParts: string[] = [];
  if (bankRef) noteParts.push(`Bank ref: ${bankRef}`);
  if (rawNote) noteParts.push(rawNote);
  const note = noteParts.length > 0 ? noteParts.join('\n') : null;
  if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
    redirect(`/app/orders/${orderNumber}/payment?err=method`);
  }

  // The receipt is required: without it there is nothing to verify.
  const file = formData.get('proof');
  let proofUrl: string | null = null;
  if (file && typeof file !== 'string' && (file as File).size > 0) {
    const f = file as File;
    if (f.size > 8_000_000) redirect(`/app/orders/${orderNumber}/payment?err=large`);
    if (!ALLOWED_MIME.includes(f.type as (typeof ALLOWED_MIME)[number])) {
      redirect(`/app/orders/${orderNumber}/payment?err=type`);
    }
    const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const buf = Buffer.from(await f.arrayBuffer());
    const up = await uploadObject(`order-proofs/${order.orderNumber}-${Date.now()}.${ext}`, buf, f.type);
    proofUrl = up.url;
  }
  if (!proofUrl) redirect(`/app/orders/${orderNumber}/payment?err=proofreq`);

  // BUG-038: the PENDING_PAYMENT precondition lives in the write's WHERE, so a
  // cancel / verify that landed meanwhile is never overwritten.
  const claim = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING_PAYMENT', holdReason: null },
    data: {
      paymentSubmittedAt: new Date(),
      paymentVerificationStatus: 'AWAITING_VERIFICATION',
      paymentVerifiedAt: null,
      paymentVerifiedById: null,
      paymentRejectionReason: null,
      paymentMethodManual: method,
      paymentNote: note,
      paymentProofUrl: proofUrl,
    },
  });
  if (claim.count !== 1) redirect(`/app/orders/${orderNumber}/payment?err=closed`);

  await notifyAdmins(
    `Payment proof submitted — order ${order.orderNumber}`,
    `Buyer uploaded a ${method.toLowerCase().replace('_', ' ')} receipt for ${formatPrice(order.totalCents, order.currency)}. Verify it from the orders queue.`,
    `/admin/orders/${order.id}`,
    'PAYMENT_SUBMITTED',
  );
  await audit('order.payment.submit', order.orderNumber, `buyer=${session.user.email} method=${method} +proof`);

  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/app/orders/${orderNumber}/payment`);
  revalidatePath('/admin/orders');
  redirect(`/app/orders/${orderNumber}/payment?ok=1`);
}

/**
 * Buyer-side: save (or correct) the billing + delivery details of an unpaid
 * order — on their own, no receipt needed. The country policy and, for orders
 * priced by the VAT rules, the VAT are re-checked; a changed amount or changed
 * printed details produce a new proforma revision (…-r2) that replaces the old
 * one (and is emailed, PROFORMA_REVISION_EMAIL). Nothing typed is lost on error.
 */
export async function buyerSaveOrderDetails(input: { orderNumber: string; details: Record<string, unknown>; saveProfile?: boolean }): Promise<PaymentActionResult> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  await ensureSettingsLoaded();
  const order = await prisma.order.findUnique({ where: { orderNumber: String(input.orderNumber ?? '') }, select: { id: true, buyerId: true, orderNumber: true, sourcingRequestId: true, customerType: true } });
  if (!order || order.buyerId !== session.user.id) return { error: 'Order not found.' };
  const parsed = parseDetailsInput(input.details ?? {}, { vatIdRule: order.customerType === 'CONSUMER' ? 'OFF' : vatIdRule() });
  if (!parsed.ok) return { error: parsed.message, fieldErrors: parsed.fieldErrors };
  const r = await saveOrderDetails(order.id, parsed.details, { actor: { id: session.user.id, email: session.user.email, kind: 'BUYER' }, saveProfile: input.saveProfile !== false });
  revalidatePath(`/app/orders/${order.orderNumber}`);
  revalidatePath(`/app/orders/${order.orderNumber}/payment`);
  revalidatePath(`/admin/orders/${order.id}`);
  if (order.sourcingRequestId) revalidatePath(`/admin/quotes/${order.sourcingRequestId}`);
  return { error: r.error, notice: r.notice, warning: r.warning, fieldErrors: r.fieldErrors };
}

/** Buyer-side: ask to pay this order on invoice (approved credit customers only, B07). */
export async function buyerRequestInvoiceTerms(input: { orderNumber: string }): Promise<PaymentActionResult> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  await ensureSettingsLoaded();
  const order = await loadOwnOrder(String(input.orderNumber ?? ''), session.user.id);
  if (!order) return { error: 'Order not found.' };
  if (order.status !== 'PENDING_PAYMENT' || order.paymentSubmittedAt) return { error: 'This order can no longer be switched to invoice payment.' };
  if (orderDetailsProblems(order, { vatIdRule: vatIdRule() }).length) return { error: 'Add your billing and delivery details first.' };
  const credit = await creditStatusFor(session.user.id, order.totalCents, order.currency);
  if (!credit.eligible) return { error: credit.reason };
  const claim = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
    data: { paymentMethodManual: 'INVOICE', paymentVerificationStatus: 'TERMS_REQUESTED', paymentRejectionReason: null },
  });
  if (claim.count !== 1) return { error: 'The order changed meanwhile. Reload the page.' };
  await notifyAdmins(
    `Invoice terms requested — order ${order.orderNumber}`,
    `${formatPrice(order.totalCents, order.currency)} · NET ${credit.termDays} · available credit ${formatPrice(credit.availableCents, order.currency)}. Approve or decline on the order page.`,
    `/admin/orders/${order.id}`,
    'PAYMENT_SUBMITTED',
  );
  await sendInternalEmail({
    to: process.env.SUPPORT_INTAKE_EMAIL ?? '',
    subject: `[action] Invoice terms requested — order ${order.orderNumber}`,
    html: mailLayout({
      heading: 'A buyer asks to pay on invoice',
      body: [`Order <strong>${order.orderNumber}</strong> (${escapeHtml(formatPrice(order.totalCents, order.currency))}) — NET ${credit.termDays}, available credit ${escapeHtml(formatPrice(credit.availableCents, order.currency))}.`, 'No money has been received. Approve the credit terms (an unpaid invoice with a due date is issued) or decline (the buyer pays by bank transfer).'],
      cta: { href: `${siteBase()}/admin/orders/${order.id}`, label: 'Open the order' },
    }),
  }, 'orders:terms-request');
  await audit('order.terms.request', order.orderNumber, `buyer=${session.user.email} NET${credit.termDays}`);
  revalidatePath(`/app/orders/${order.orderNumber}/payment`);
  revalidatePath(`/admin/orders/${order.id}`);
  return { notice: `Request sent: pay order ${order.orderNumber} on invoice (NET ${credit.termDays}). We confirm by email — you then receive the invoice with its due date. Until then nothing is due.` };
}

/** Buyer-side: cancel an unpaid order — a quote order or a checkout order
 *  (BUYER_CAN_CANCEL_UNPAID_ORDER). One path: lib/fulfilment/cancel.ts. */
export async function buyerCancelUnpaidOrder(input: { orderNumber: string; reason: string; note?: string | null }): Promise<PaymentActionResult> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  await ensureSettingsLoaded();
  if (!buyerCanCancelUnpaid()) return { error: 'Orders can not be canceled online — contact support.' };
  const reason = String(input.reason ?? '').trim();
  if (!cancelReasons().includes(reason)) return { error: 'Choose a reason.' };
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const order = await prisma.order.findUnique({ where: { orderNumber: String(input.orderNumber ?? '') }, select: { id: true, orderNumber: true, buyerId: true, sourcingRequestId: true } });
  if (!order || order.buyerId !== session.user.id) return { error: 'Order not found.' };
  const r = await cancelUnpaidOrder(order.id, { kind: 'BUYER', id: session.user.id, email: session.user.email }, { reason, note });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/app/orders/${order.orderNumber}`);
  revalidatePath(`/app/orders/${order.orderNumber}/payment`);
  revalidatePath('/app/orders');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${order.id}`);
  if (order.sourcingRequestId) {
    revalidatePath(`/app/quotes/${order.sourcingRequestId}`);
    revalidatePath('/app/quotes');
    revalidatePath(`/admin/quotes/${order.sourcingRequestId}`);
    revalidatePath('/admin/quotes');
  }
  return { notice: r.message };
}

/**
 * Buyer-side: add (or correct) the shipping address after payment, until the
 * order ships. Proforma orders are created without an address and the payment
 * form closes once PAID — without this a paid order could be stuck unshippable.
 */
export async function buyerSetShippingAddress(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  if (!orderNumber) redirect('/app/orders');
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: { id: true, buyerId: true, status: true, shippingAddress: true, openHolds: true },
  });
  if (!order || order.buyerId !== session.user.id) redirect('/app/orders');
  const EDITABLE = ['PAID', 'PROCESSING'] as const;
  if (!(EDITABLE as readonly string[]).includes(order.status)) {
    redirect(`/app/orders/${orderNumber}?addr=closed`);
  }

  const get = (k: string) => String(formData.get(k) ?? '').trim();
  const f = {
    name: get('addr_name').slice(0, 120),
    phone: get('addr_phone').slice(0, 40),
    line1: get('addr_line1').slice(0, 200),
    line2: get('addr_line2').slice(0, 200),
    city: get('addr_city').slice(0, 80),
    postal: get('addr_postal').slice(0, 24),
    state: get('addr_state').slice(0, 80),
    country: get('addr_country').toUpperCase(),
  };
  if (!f.name || !f.phone || !f.line1 || !f.city || !f.postal || !/^[A-Z]{2}$/.test(f.country)) {
    redirect(`/app/orders/${orderNumber}?addr=missing`);
  }
  // A12: country policy + POST_PAYMENT_ADDRESS_CHANGE (Settings → Shipping).
  const verdict = await evaluateAddressChange(order, f.country, 'BUYER');
  if (!verdict.ok) {
    redirect(`/app/orders/${orderNumber}?addr=${verdict.code === 'BLOCKED' ? 'blocked' : verdict.code === 'NEVER' ? 'never' : 'samecountry'}`);
  }

  const existing = (order.shippingAddress as Record<string, unknown> | null) ?? {};
  const existingAddr = (existing.address as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...existing,
    name: f.name,
    phone: f.phone,
    email: (existing.email as string | undefined) || session.user.email,
    address: {
      ...existingAddr,
      line1: f.line1,
      line2: f.line2 || null,
      city: f.city,
      postal_code: f.postal,
      state: f.state || null,
      country: f.country,
    },
  };
  // Status precondition in the WHERE so a concurrent "shipped" can't be re-addressed.
  const res = await prisma.order.updateMany({
    where: { id: order.id, buyerId: session.user.id, status: { in: [...EDITABLE] } },
    data: { shippingAddress: next as Prisma.InputJsonValue },
  });
  if (res.count !== 1) redirect(`/app/orders/${orderNumber}?addr=closed`);
  await recordAddressChange(prisma, {
    orderId: order.id, kind: 'SHIPPING', oldValue: order.shippingAddress, newValue: next,
    actorRole: 'BUYER', actorId: session.user.id, verdict, nextCountry: f.country,
  });

  await notifyAdmins(
    verdict.hold ? `Order ${orderNumber}: buyer changed the address — review needed` : `Order ${orderNumber}: buyer added a shipping address`,
    verdict.hold ? `${f.city}, ${f.country}. ${verdict.note} Do not ship until it is approved.` : `${f.city}, ${f.country} — the order can now be shipped.`,
    `/admin/orders/${order.id}`,
  );
  await audit('order.address.buyer', orderNumber, `${f.city}, ${f.country} — ${verdict.note}`.slice(0, 500));
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/admin/orders/${order.id}`);
  revalidatePath('/admin/orders');
  redirect(`/app/orders/${orderNumber}?addr=${verdict.hold ? 'review' : 'saved'}`);
}
