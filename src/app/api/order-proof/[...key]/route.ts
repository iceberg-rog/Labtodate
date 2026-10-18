import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { streamSupportAttachment } from '@/lib/storage/s3';
import { storedFileHeaders } from '@/lib/storage/file-type';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth-gated proxy for buyer-uploaded payment receipts (S3 prefix
 * `order-proofs/*`). Receipts are stored in the private side of the bucket;
 * direct S3 fetches return 403. Only the buyer who uploaded it or an admin
 * with orders:view can stream it through this route — every receipt of the
 * order, not only the latest (PaymentProof rows).
 *
 * On success: streams the bytes with a private cache header.
 * Otherwise:  404 (never reveal whether the key exists vs is forbidden).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ key: string[] }> }) {
  const params = await props.params;
  const segments = params.key ?? [];
  if (segments.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const key = segments.join('/');

  // Lock this proxy to the order-proofs prefix so it can't be turned into a
  // generic S3 reader for unrelated private keys (support-att, etc.).
  if (!key.startsWith('order-proofs/')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const session = await getServerSession();
  if (!session?.user) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // We don't trust the URL — look the key up in the records that legitimately
  // store private receipts under this prefix:
  //   1. PaymentProof → every receipt event of an order (uploads, rejected and
  //      part-payment receipts, staff-attached proofs), kept after a new upload
  //   2. Payment.proofKey → the receipt a ledger payment was booked with
  //   3. Order.paymentProofUrl → the latest receipt (orders from before 1.)
  //   4. SellSubmission.paymentReceiptUrl → we uploaded a transfer receipt to PAY the seller
  // The buyer may open what they uploaded themselves; a proof staff attached
  // when booking a payment (it can be a bank statement) is for staff only.
  const proofs = await prisma.paymentProof.findMany({
    where: { key },
    select: { kind: true, order: { select: { buyerId: true } } },
    take: 10,
  });
  const payment = proofs.length
    ? null
    : await prisma.payment.findFirst({ where: { proofKey: { endsWith: key } }, select: { order: { select: { buyerId: true } } } });
  const order = proofs.length || payment
    ? null
    : await prisma.order.findFirst({
        where: { paymentProofUrl: { endsWith: key } },
        select: { buyerId: true },
      });
  const sellSubmission = proofs.length || payment || order
    ? null
    : await prisma.sellSubmission.findFirst({
        where: { paymentReceiptUrl: { endsWith: key } },
        select: { submittedById: true, email: true },
      });

  if (!proofs.length && !payment && !order && !sellSubmission) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const userId = session.user.id;
  const isOwner = proofs.length
    ? proofs.some((p) => p.kind !== 'MANUAL' && p.order.buyerId === userId)
    : payment
      ? payment.order.buyerId === userId
      : order
        ? order.buyerId === userId
        : sellSubmission!.submittedById === userId
          || (sellSubmission!.email?.toLowerCase() === session.user.email?.toLowerCase());

  // Staff need the permission for the record the receipt belongs to (A31):
  // payment receipts are financial documents, not for every admin.
  const staffAllowed =
    session.user.role === 'ADMIN' && (await hasCapability(sellSubmission ? 'sell:view' : 'orders:view'));

  if (!staffAllowed && !isOwner) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const { body, contentType, contentLength } = await streamSupportAttachment(key);
    if (!body) return NextResponse.json({ error: 'not found' }, { status: 404 });
    // Same safe-serving headers as the support-attachment proxy: receipts are
    // stored with the uploader's declared type, so never let it run as a page.
    const headers = storedFileHeaders(contentType, contentLength, 'private, max-age=60');
    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
