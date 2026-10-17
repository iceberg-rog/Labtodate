import { prisma } from '@/lib/db';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { orderLineTruthSnapshot, type OrderLineTruthSnapshot } from '@/lib/catalog/warranty';

/**
 * What each product promises right now (condition label + warranty), to be
 * written onto the order line at the moment of sale. Later edits of the
 * product, its condition grade or the fallback text never change an order
 * that was already placed — the invoice prints this snapshot.
 */
export async function orderLineTruthFor(productIds: readonly (string | null | undefined)[]): Promise<Map<string, OrderLineTruthSnapshot>> {
  const ids = Array.from(new Set(productIds.filter((x): x is string => !!x)));
  const out = new Map<string, OrderLineTruthSnapshot>();
  if (!ids.length) return out;
  const [products, grades, policy] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, condition: true, warrantyMonths: true, warrantyText: true } }),
    getConditionGrades(),
    getCatalogPolicy(),
  ]);
  for (const p of products) {
    out.set(p.id, orderLineTruthSnapshot(p, grades[p.condition], policy.warrantyFallbackText, policy.warrantyMonthsFormat));
  }
  return out;
}
