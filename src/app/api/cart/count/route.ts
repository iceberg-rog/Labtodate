import { NextResponse } from 'next/server';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Number of rows in the signed-in buyer's cart (0 for guests) — feeds the
 *  header cart badge. Same count as the "N items" line on /app/cart. */
export async function GET() {
  const session = await getServerSession();
  const count = session
    ? await prisma.cartItem.count({ where: { userId: session.user.id } })
    : 0;
  return NextResponse.json({ count }, { headers: { 'Cache-Control': 'private, no-store' } });
}
