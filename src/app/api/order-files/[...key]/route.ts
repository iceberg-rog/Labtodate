import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { streamSupportAttachment } from '@/lib/storage/s3';
import { storedFileHeaders } from '@/lib/storage/file-type';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth-gated proxy for the private files of the fulfilment area: return photos
 * (return-files/), return labels (return-labels/), proofs of delivery
 * (shipment-pod/) and refund transfer proofs (refund-proofs/). The key is
 * looked up in the record that owns it; the order's buyer or staff with
 * orders:view may read it. Anything else is a 404 (never reveals existence).
 */
const PREFIXES = ['return-files/', 'return-labels/', 'shipment-pod/', 'refund-proofs/'];

async function ownerOrderId(key: string): Promise<string | null> {
  if (key.startsWith('return-files/')) return (await prisma.returnRequest.findFirst({ where: { attachments: { has: key } }, select: { orderId: true } }))?.orderId ?? null;
  if (key.startsWith('return-labels/')) return (await prisma.returnRequest.findFirst({ where: { labelKey: key }, select: { orderId: true } }))?.orderId ?? null;
  if (key.startsWith('shipment-pod/')) return (await prisma.shipment.findFirst({ where: { podKey: key }, select: { orderId: true } }))?.orderId ?? null;
  if (key.startsWith('refund-proofs/')) return (await prisma.refund.findFirst({ where: { proofKey: key }, select: { orderId: true } }))?.orderId ?? null;
  return null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ key: string[] }> }) {
  const key = ((await props.params).key ?? []).join('/');
  const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!PREFIXES.some((p) => key.startsWith(p)) || key.includes('..')) return notFound();
  const session = await getServerSession();
  if (!session?.user) return notFound();
  const orderId = await ownerOrderId(key);
  if (!orderId) return notFound();
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true } });
  if (!order) return notFound();
  const staff = session.user.role === 'ADMIN' && (await hasCapability('orders:view'));
  if (!staff && order.buyerId !== session.user.id) return notFound();
  try {
    const { body, contentType, contentLength } = await streamSupportAttachment(key);
    if (!body) return notFound();
    return new NextResponse(body, { status: 200, headers: storedFileHeaders(contentType, contentLength, 'private, max-age=60') });
  } catch {
    return notFound();
  }
}
