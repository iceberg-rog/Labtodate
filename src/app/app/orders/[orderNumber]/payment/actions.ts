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
  // (buyer corrects a wrong file before admin reviews).
  if (order.status !== 'PENDING_PAYMENT') {
    redirect(`/app/orders/${orderNumber}/payment?err=closed`);
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
    redirect(`/app/orders/${orderNumber}/payment?err=closed`);
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
  if (method === 'BANK_TRANSFER' && !proofUrl) {
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

  await prisma.order.update({
    where: { id: order.id },
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
  redirect(`/app/orders/${orderNumber}/payment?ok=1`);
}
