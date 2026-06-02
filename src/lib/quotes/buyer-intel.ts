import { prisma } from '@/lib/db';

export interface BuyerIntel {
  totalRfqs: number;
  rfqsByOutcome: { won: number; lost: number; open: number };
  paidOrders: number;
  lifetimeCents: number;
  avgDealCents: number;          // mean of won orders
  paymentReliability: number | null; // 0..1 share of orders paid within 7d of accept; null if no data
  lastOutcome: 'won' | 'lost' | 'open' | null;
  lastOutcomeAt: Date | null;
  suppliersInteracted: number;   // distinct assignedToId across the buyer's RFQs
  countries: string[];           // distinct shipping-address countries from their orders
  repeatRate: number | null;     // share of buyers who came back ≥ 2 times (here: 1 if paidOrders ≥ 2)
}

/**
 * Compute compact intelligence for the buyer behind a quote — feeds the
 * detail-page sidebar. Optimised: 2 DB calls (RFQs aggregate + orders) for
 * any single buyer; returns null fields when the buyer is a guest with no
 * registered account.
 */
export async function buildBuyerIntel(
  buyerEmail: string,
  buyerUserId: string | null,
): Promise<BuyerIntel> {
  const empty: BuyerIntel = {
    totalRfqs: 0,
    rfqsByOutcome: { won: 0, lost: 0, open: 0 },
    paidOrders: 0,
    lifetimeCents: 0,
    avgDealCents: 0,
    paymentReliability: null,
    lastOutcome: null,
    lastOutcomeAt: null,
    suppliersInteracted: 0,
    countries: [],
    repeatRate: null,
  };

  // RFQs by email OR submittedById — covers guest who later registered.
  const rfqs = await prisma.sourcingRequest.findMany({
    where: {
      OR: [
        { buyerEmail: { equals: buyerEmail, mode: 'insensitive' } },
        ...(buyerUserId ? [{ submittedById: buyerUserId }] : []),
      ],
    },
    select: { id: true, status: true, assignedToId: true, createdAt: true, updatedAt: true },
  });
  if (rfqs.length === 0 && !buyerUserId) return empty;

  const wonStatuses = new Set(['ACCEPTED']);
  const lostStatuses = new Set(['DECLINED', 'CLOSED']);
  const openStatuses = new Set(['PENDING', 'RESPONDED']);

  const rfqsByOutcome = rfqs.reduce(
    (acc, r) => {
      if (wonStatuses.has(r.status)) acc.won++;
      else if (lostStatuses.has(r.status)) acc.lost++;
      else if (openStatuses.has(r.status)) acc.open++;
      return acc;
    },
    { won: 0, lost: 0, open: 0 },
  );

  const suppliersInteracted = new Set(rfqs.map((r) => r.assignedToId).filter(Boolean)).size;

  // Last outcome — sort by updatedAt desc and pick first non-open if any.
  const sorted = [...rfqs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const lastTerminal = sorted.find((r) => wonStatuses.has(r.status) || lostStatuses.has(r.status));
  const lastOutcome: BuyerIntel['lastOutcome'] = lastTerminal
    ? wonStatuses.has(lastTerminal.status) ? 'won' : 'lost'
    : sorted[0]
    ? 'open'
    : null;
  const lastOutcomeAt = (lastTerminal ?? sorted[0])?.updatedAt ?? null;

  // Orders — for paid count, lifetime spend, avg deal, reliability, countries.
  let paidOrders = 0;
  let lifetimeCents = 0;
  let avgDealCents = 0;
  let paymentReliability: number | null = null;
  let countries: string[] = [];

  if (buyerUserId) {
    const orders = await prisma.order.findMany({
      where: { buyerId: buyerUserId },
      select: { id: true, status: true, totalCents: true, paidAt: true, createdAt: true, shippingAddress: true },
    });
    const paidLike = new Set(['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
    const paid = orders.filter((o) => paidLike.has(o.status));
    paidOrders = paid.length;
    lifetimeCents = paid.reduce((s, o) => s + o.totalCents, 0);
    avgDealCents = paid.length > 0 ? Math.round(lifetimeCents / paid.length) : 0;

    // Reliability: paid within 7 days of order creation / 100% as best heuristic
    // without an "accepted at" timestamp on Order. Falls back to null if no
    // signal.
    const withPaidTime = paid.filter((o) => o.paidAt);
    if (withPaidTime.length > 0) {
      const ontime = withPaidTime.filter((o) => {
        const dt = (o.paidAt!.getTime() - o.createdAt.getTime()) / (24 * 3600 * 1000);
        return dt <= 7;
      }).length;
      paymentReliability = ontime / withPaidTime.length;
    }

    // Countries: any country code or name from shippingAddress.
    const ctry = new Set<string>();
    for (const o of orders) {
      const a = o.shippingAddress as { country?: string; address?: { country?: string } } | null;
      const c = a?.country ?? a?.address?.country;
      if (c && typeof c === 'string') ctry.add(c);
    }
    countries = Array.from(ctry);
  }

  const repeatRate: number | null = paidOrders >= 2 ? 1 : paidOrders === 1 ? 0 : null;

  return {
    totalRfqs: rfqs.length,
    rfqsByOutcome,
    paidOrders,
    lifetimeCents,
    avgDealCents,
    paymentReliability,
    lastOutcome,
    lastOutcomeAt,
    suppliersInteracted,
    countries,
    repeatRate,
  };
}
