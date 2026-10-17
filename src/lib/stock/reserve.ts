import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingInt, settingIntOrNull } from '@/lib/settings';

/**
 * Stock reservations (A09 / B28 groundwork): ONE model for holding units for
 * an order, an accepted quote or a cart.
 *
 * Product.quantity stays the AVAILABLE count (as the checkout already uses it):
 *  - reserveStock()      guarded decrement (quantity >= qty) + a StockReservation
 *                        row, in one transaction. Idempotent per (source, refId,
 *                        productId) — a partial unique index guarantees one
 *                        active hold.
 *  - releaseReservation() claims the hold ONCE (releasedAt) and puts the units
 *                        back — double clicks / overlapping sweeps restock once.
 *  - consumeReservation() the units were sold (payment / dispatch): the hold
 *                        ends without restock.
 *  - releaseExpiredReservations() for the sweep cron.
 */

type Db = Prisma.TransactionClient;
export type ReservationSource = 'ORDER' | 'QUOTE' | 'CART';

export type ReserveResult =
  | { ok: true; reservationId: string; created: boolean }
  | { ok: false; reason: 'UNAVAILABLE' | 'BAD_QTY'; message: string };

async function inTx<T>(tx: Db | undefined, fn: (tx: Db) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : prisma.$transaction(fn);
}

/** When a new hold expires: RESERVATION_HOLD_DAYS, else payment term + grace. */
export async function reservationExpiry(now = new Date()): Promise<Date> {
  await ensureSettingsLoaded();
  const days = settingIntOrNull('RESERVATION_HOLD_DAYS') ?? settingInt('PAYMENT_TERM_DAYS', 14) + settingInt('PAYMENT_GRACE_DAYS', 3);
  return new Date(now.getTime() + days * 86_400_000);
}

export async function reserveStock(
  p: { productId: string; qty: number; source: ReservationSource; refId: string; orderId?: string | null; expiresAt?: Date | null },
  tx?: Db,
): Promise<ReserveResult> {
  if (!Number.isInteger(p.qty) || p.qty <= 0) return { ok: false, reason: 'BAD_QTY', message: 'Quantity must be a positive whole number.' };
  try {
    return await inTx(tx, async (db) => {
      const existing = await db.stockReservation.findFirst({
        where: { source: p.source, refId: p.refId, productId: p.productId, releasedAt: null, consumedAt: null },
        select: { id: true },
      });
      if (existing) return { ok: true as const, reservationId: existing.id, created: false };
      const dec = await db.product.updateMany({
        where: { id: p.productId, quantity: { gte: p.qty } },
        data: { quantity: { decrement: p.qty } },
      });
      if (dec.count !== 1) return { ok: false as const, reason: 'UNAVAILABLE' as const, message: 'Not enough units in stock (sold or reserved by another order).' };
      const r = await db.stockReservation.create({
        data: { productId: p.productId, qty: p.qty, source: p.source, refId: p.refId, orderId: p.orderId ?? null, expiresAt: p.expiresAt ?? null },
        select: { id: true },
      });
      return { ok: true as const, reservationId: r.id, created: true };
    });
  } catch (e) {
    // Concurrent duplicate hold: the partial unique index fired — the other one won.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && !tx) {
      const existing = await prisma.stockReservation.findFirst({
        where: { source: p.source, refId: p.refId, productId: p.productId, releasedAt: null, consumedAt: null },
        select: { id: true },
      });
      if (existing) return { ok: true, reservationId: existing.id, created: false };
    }
    throw e;
  }
}

/** Release active holds (by id, or every hold of a source/ref). Returns units put back. */
export async function releaseReservation(
  where: { reservationId: string } | { source: ReservationSource; refId: string },
  reason: string,
  tx?: Db,
): Promise<number> {
  return inTx(tx, async (db) => {
    const holds = await db.stockReservation.findMany({
      where: { ...('reservationId' in where ? { id: where.reservationId } : { source: where.source, refId: where.refId }), releasedAt: null, consumedAt: null },
      select: { id: true, productId: true, qty: true },
    });
    let units = 0;
    for (const h of holds) {
      const claim = await db.stockReservation.updateMany({
        where: { id: h.id, releasedAt: null, consumedAt: null },
        data: { releasedAt: new Date(), releaseReason: reason.slice(0, 200) },
      });
      if (claim.count !== 1) continue; // someone else released / consumed it
      await db.product.updateMany({ where: { id: h.productId }, data: { quantity: { increment: h.qty } } });
      units += h.qty;
    }
    return units;
  });
}

/** The held units were sold: end the hold WITHOUT restocking. */
export async function consumeReservation(where: { source: ReservationSource; refId: string }, tx?: Db): Promise<number> {
  return inTx(tx, async (db) => {
    const r = await db.stockReservation.updateMany({
      where: { source: where.source, refId: where.refId, releasedAt: null, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return r.count;
  });
}

/** Sweep: release every hold past its expiry. Returns the number released. */
export async function releaseExpiredReservations(now = new Date()): Promise<number> {
  const due = await prisma.stockReservation.findMany({
    where: { releasedAt: null, consumedAt: null, expiresAt: { lt: now } },
    select: { id: true },
    take: 200,
    orderBy: { expiresAt: 'asc' },
  });
  let n = 0;
  for (const d of due) if ((await releaseReservation({ reservationId: d.id }, 'Hold expired')) > 0) n++;
  return n;
}

/** Units currently held for a product (for "Reserved" badges / admin views). */
export async function reservedUnits(productId: string): Promise<number> {
  const r = await prisma.stockReservation.aggregate({ where: { productId, releasedAt: null, consumedAt: null }, _sum: { qty: true } });
  return r._sum.qty ?? 0;
}
