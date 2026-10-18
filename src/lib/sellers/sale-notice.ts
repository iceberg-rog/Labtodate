/**
 * Tells the supplier who owns a sold unit what happened to the sale (paid →
 * prepare it for dispatch, shipped, delivered, canceled). Interface only for
 * now: nothing is sent yet. Callers invoke it after the order change is
 * committed; it must never throw into them.
 */

export type SaleNoticeEvent = 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELED';

export async function notifySupplierOfSale(orderId: string, event: SaleNoticeEvent): Promise<void> {
  void orderId;
  void event;
}
