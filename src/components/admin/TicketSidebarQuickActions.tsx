'use client';

import Link from 'next/link';
import { ShieldCheck, ExternalLink, Truck } from 'lucide-react';

/**
 * Quick-action buttons rendered inside the linked-commerce sidebar card so
 * the operator can resolve common ticket reasons (verify a stuck payment,
 * open the order page, jump to tracking) without leaving the ticket page.
 */
export function TicketSidebarQuickActions({
  orderId,
  orderNumber,
  status,
  paymentVerificationStatus,
}: {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentVerificationStatus: string | null;
}) {
  const canVerify = paymentVerificationStatus === 'AWAITING_VERIFICATION';

  return (
    <div className="pt-3 mt-3 border-t border-border flex items-center gap-2 flex-wrap">
      {canVerify && (
        // Verifying records the amount and value date from the bank statement: on the order page.
        <Link
          href={`/admin/orders/${orderId}#verify`}
          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-emerald-700 text-white text-[11px] font-bold hover:bg-emerald-800"
        >
          <ShieldCheck className="h-3.5 w-3.5" /> Verify payment…
        </Link>
      )}
      <Link
        href={`/admin/orders/${orderId}`}
        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-border bg-card text-[11px] font-semibold hover:bg-foreground/5"
      >
        <ExternalLink className="h-3 w-3" /> Open order
      </Link>
      {['PAID', 'PROCESSING', 'SHIPPED'].includes(status) && (
        <Link
          href={`/admin/orders/${orderId}/invoice`}
          target="_blank"
          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-border bg-card text-[11px] font-semibold hover:bg-foreground/5"
        >
          <Truck className="h-3 w-3" /> Invoice
        </Link>
      )}
    </div>
  );
}
