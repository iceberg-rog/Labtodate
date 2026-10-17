import Link from 'next/link';
import { Truck } from 'lucide-react';

/**
 * Overview shortcut to the orders waiting for dispatch. Shipping itself happens
 * in the orders list (select → “Ship selected”, one carrier + tracking number
 * per order) or on the order page — every path records a shipment, checks the
 * delivery / billing details and emails the buyer the tracking link. A blind
 * “ship everything” without tracking is not offered.
 */
export function BulkShipButton({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Link
      href="/admin/orders?status=PAID,PROCESSING"
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold"
    >
      <Truck className="h-3.5 w-3.5" /> Ship {count} paid order{count === 1 ? '' : 's'}…
    </Link>
  );
}
