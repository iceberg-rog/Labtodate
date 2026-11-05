/**
 * How many units an order line holds off the listing's stock, i.e. what a
 * cancel or refund must give back. Lines record what was actually taken
 * (`stockTaken`); older lines without it fall back to the ordered quantity,
 * which is how the stock code treated them before the column existed.
 * Pure: safe to import from transaction helpers.
 */
export function unitsHeld(item: { quantity: number; stockTaken?: number | null }): number {
  const n = item.stockTaken ?? item.quantity;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
