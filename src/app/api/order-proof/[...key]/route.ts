import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { streamSupportAttachment } from '@/lib/storage/s3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth-gated proxy for buyer-uploaded payment receipts (S3 prefix
 * `order-proofs/*`). Receipts are stored in the private side of the bucket;
 * direct S3 fetches return 403. Only the buyer who uploaded it or an admin
 * (with orders:fulfil / orders:view) can stream it through this route.
 *
 * On success: streams the bytes with a private cache header.
 * Otherwise:  404 (never reveal whether the key exists vs is forbidden).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { key: string[] } },
) {
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

  const isAdmin = session.user.role === 'ADMIN';

  // We don't trust the URL — look the key up in both tables that legitimately
  // store private receipts under this prefix:
  //   1. Order.paymentProofUrl  → buyer uploaded a bank-transfer receipt to PAY us
  //   2. SellSubmission.paymentReceiptUrl → we uploaded a transfer receipt to PAY the seller
  // First match wins; the owner is whoever submitted the relevant record.
  const order = await prisma.order.findFirst({
    where: { paymentProofUrl: { endsWith: key } },
    select: { buyerId: true },
  });
  const sellSubmission = order
    ? null
    : await prisma.sellSubmission.findFirst({
        where: { paymentReceiptUrl: { endsWith: key } },
        select: { submittedById: true, email: true },
      });

  if (!order && !sellSubmission) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const isOwner = order
    ? order.buyerId === session.user.id
    : sellSubmission!.submittedById === session.user.id
      || (sellSubmission!.email?.toLowerCase() === session.user.email?.toLowerCase());

  if (!isAdmin && !isOwner) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const { body, contentType, contentLength } = await streamSupportAttachment(key);
    if (!body) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const headers: Record<string, string> = {
      'content-type': contentType,
      'cache-control': 'private, max-age=60',
    };
    if (typeof contentLength === 'number') headers['content-length'] = String(contentLength);
    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
