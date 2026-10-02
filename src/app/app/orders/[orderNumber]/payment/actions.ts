'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { requireSession } from '@/lib/auth-server';
import { uploadObject } from '@/lib/storage/s3';
import { audit, notifyAdmins } from '@/lib/observability';

const ALLOWED_METHODS = ['BANK_TRANSFER', 'INVOICE', 'OTHER'] as const;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;

/**
 * Buyer-side: upload payment proof + (optionally) complete shipping address +
 * VAT/company info. Moves the order into AWAITING_VERIFICATION; an admin then
 * reviews via verifyPayment / rejectPayment.
 */
export async function buyerSubmitPaymentProof(formData: FormData): Promise<void> {
  const session = await requireSession({ redirectTo: '/auth/sign-in' });
  const orderNumber = String(formData.get('orderNumber') ?? '').trim();
  if (!orderNumber) redirect('/app/orders');

  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: {
      id: true, orderNumber: true, buyerId: true, status: true,
      shippingAddress: true, billingAddress: true,
      paymentVerificationStatus: true,
      sourcingRequestId: true,
    },
  });
  if (!order || order.buyerId !== session.user.id) redirect('/app/orders');

  // Only PENDING_PAYMENT orders accept proof. Once VERIFIED/PAID we don't
  // want to overwrite the receipt. AWAITING_VERIFICATION can be replaced
  // (buyer corrects a wrong file before admin reviews). A canceled order gets
  // its own message: the buyer must not think a transfer is still expected.
  if (order.status !== 'PENDING_PAYMENT') {
    redirect(`/app/orders/${orderNumber}/payment?err=${order.status === 'CANCELED' ? 'canceled' : 'closed'}`);
  }

  // Defense-in-depth: re-check proforma TTL on the server. The cron sweep
  // normally flips the order to CANCELED first (which the check above
  // catches), but in the race window between expiry and the next sweep we
  // still refuse new submissions.
  const sr = await prisma.sourcingRequest.findFirst({
    where: { id: order.sourcingRequestId ?? '__none__' },
    select: { status: true, validUntilAt: true },
  });
  if (sr?.validUntilAt && sr.validUntilAt.getTime() < Date.now()) {
    redirect(`/app/orders/${orderNumber}/payment?err=expired`);
  }
  // A declined/closed quote ended the deal (its order is canceled on decline;
  // this also covers orders left over from before that).
  if (sr && (sr.status === 'DECLINED' || sr.status === 'CLOSED')) {
    redirect(`/app/orders/${orderNumber}/payment?err=canceled`);
  }

  const get = (k: string) => String(formData.get(k) ?? '').trim();
  const method = get('method').toUpperCase();
  const rawNote = get('note').slice(0, 500);
  const poNumber = get('po_number').slice(0, 60);
  const bankRef = get('bank_ref').slice(0, 60);
  // Combine PO + bank ref + freeform note into the single paymentNote field
  // (no schema change needed). Admin sees this clearly in /admin/orders/[id].
  const noteParts: string[] = [];
  if (poNumber) noteParts.push(`PO: ${poNumber}`);
  if (bankRef) noteParts.push(`Bank ref: ${bankRef}`);
  if (rawNote) noteParts.push(rawNote);
  const note = noteParts.length > 0 ? noteParts.join('\n') : null;
  if (!ALLOWED_METHODS.includes(method as (typeof ALLOWED_METHODS)[number])) {
    redirect(`/app/orders/${orderNumber}/payment?err=method`);
  }

  // Optional address completion (only patched if buyer provided fields).
  const addrFields = {
    name: get('addr_name').slice(0, 120),
    phone: get('addr_phone').slice(0, 40),
    line1: get('addr_line1').slice(0, 200),
    line2: get('addr_line2').slice(0, 200),
    city: get('addr_city').slice(0, 80),
    postal: get('addr_postal').slice(0, 24),
    state: get('addr_state').slice(0, 80),
    country: get('addr_country').slice(0, 2).toUpperCase(),
    vat: get('addr_vat').slice(0, 40),
    company: get('addr_company').slice(0, 120),
  };
  const wantsAddrUpdate = !!(addrFields.line1 || addrFields.city || addrFields.postal || addrFields.country || addrFields.vat || addrFields.company);

  // Receipt upload — required for BANK_TRANSFER / OTHER, optional for INVOICE.
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
  // Without a file there is nothing for an admin to verify for a transfer or
  // an "other" payment — refuse instead of queueing an empty proof.
  if ((method === 'BANK_TRANSFER' || method === 'OTHER') && !proofUrl) {
    redirect(`/app/orders/${orderNumber}/payment?err=proofreq`);
  }

  // Merge shipping address (preserve existing fields not touched in the form).
  let newShippingAddress = order.shippingAddress;
  if (wantsAddrUpdate) {
    const existing = (order.shippingAddress as Record<string, unknown> | null) ?? {};
    const existingAddr = (existing.address as Record<string, unknown> | undefined) ?? {};
    newShippingAddress = {
      ...existing,
      name: addrFields.name || (existing.name as string | undefined) || '',
      phone: addrFields.phone || (existing.phone as string | undefined) || '',
      company: addrFields.company || (existing.company as string | undefined) || null,
      vat: addrFields.vat || (existing.vat as string | undefined) || null,
      address: {
        ...existingAddr,
        line1: addrFields.line1 || (existingAddr.line1 as string | undefined) || '',
        line2: addrFields.line2 || (existingAddr.line2 as string | undefined) || null,
        city: addrFields.city || (existingAddr.city as string | undefined) || '',
        postal_code: addrFields.postal || (existingAddr.postal_code as string | undefined) || '',
        state: addrFields.state || (existingAddr.state as string | undefined) || null,
        country: addrFields.country || (existingAddr.country as string | undefined) || '',
      },
    };
  }

  // BUG-038: claim the transition atomically. The PENDING_PAYMENT precondition
  // must live in the write's WHERE, not only in the stale-snapshot `if` above.
  // Otherwise a cron proforma/orphan cancel (status->CANCELED) or an admin verify
  // (status->PAID) that lands between our read (line ~24) and this write — the S3
  // upload above can take seconds — would be silently overwritten: an
  // unconditional update({where:{id}}) stamps AWAITING_VERIFICATION +
  // paymentSubmittedAt onto an already-CANCELED (and already-restocked) or PAID
  // order, dropping a phantom receipt into the admin verify queue. S11 guards the
  // forward edge (a receipt-in-flight order is never auto-canceled); this guards
  // the reverse edge (a buyer submit must not resurrect an order that left
  // PENDING_PAYMENT). Mirror the cron/admin pattern: updateMany + count===1 gate
  // so the loser of the race no-ops cleanly with no side effects. Legitimate
  // receipt re-submission is unaffected — replacing a receipt keeps status =
  // PENDING_PAYMENT (only paymentVerificationStatus changes), so the WHERE matches.
  const claim = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING_PAYMENT' },
    data: {
      paymentSubmittedAt: new Date(),
      paymentVerificationStatus: 'AWAITING_VERIFICATION',
      paymentVerifiedAt: null,
      paymentVerifiedById: null,
      paymentRejectionReason: null,
      paymentMethodManual: method,
      paymentNote: note,
      ...(proofUrl ? { paymentProofUrl: proofUrl } : {}),
      ...(wantsAddrUpdate ? { shippingAddress: newShippingAddress as Prisma.InputJsonValue } : {}),
    },
  });
  if (claim.count !== 1) {
    // The order stopped accepting proof since we read it (canceled by the
    // expiry/orphan sweep, or already moved to PAID by an admin verify). Don't
    // notify admins and don't audit a phantom submission — send the buyer to the
    // closed view, consistent with the snapshot guard above.
    redirect(`/app/orders/${orderNumber}/payment?err=closed`);
  }

  await notifyAdmins(
    `Payment proof submitted — order ${order.orderNumber}`,
    `Buyer uploaded a ${method.toLowerCase().replace('_', ' ')} receipt. Verify it from the orders queue.`,
    `/admin/orders/${order.id}`,
    'PAYMENT_SUBMITTED',
  );
  await audit('order.payment.submit', order.orderNumber, `buyer=${session.user.email} method=${method}${proofUrl ? ' +proof' : ''}`);

  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/app/orders/${orderNumber}/payment`);
  revalidatePath('/admin/orders');
  // ok=1: receipt file stored; ok=2: details submitted without a file (INVOICE).
  redirect(`/app/orders/${orderNumber}/payment?ok=${proofUrl ? '1' : '2'}`);
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
    select: { id: true, buyerId: true, status: true, shippingAddress: true },
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

  await notifyAdmins(
    `Order ${orderNumber}: buyer added a shipping address`,
    `${f.city}, ${f.country} — the order can now be shipped.`,
    `/admin/orders/${order.id}`,
  );
  await audit('order.address.buyer', orderNumber, `${f.city}, ${f.country}`);
  revalidatePath(`/app/orders/${orderNumber}`);
  revalidatePath(`/admin/orders/${order.id}`);
  revalidatePath('/admin/orders');
  redirect(`/app/orders/${orderNumber}?addr=saved`);
}
