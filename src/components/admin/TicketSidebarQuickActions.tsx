'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ShieldCheck, ExternalLink, Truck, Loader2 } from 'lucide-react';
import { verifyPayment } from '@/app/admin/actions';

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
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const canVerify = paymentVerificationStatus === 'AWAITING_VERIFICATION';

  return (
    <div className="pt-3 mt-3 border-t border-border flex items-center gap-2 flex-wrap">
      {canVerify && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setMsg(null);
            start(async () => {
              const fd = new FormData();
              fd.set('orderId', orderId);
              try {
                const r = await verifyPayment(fd);
                setMsg(r?.message ?? 'Payment verified.');
                router.refresh();
              } catch (e) {
                setMsg(e instanceof Error ? e.message : 'Verify failed');
              }
            });
          }}
          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md bg-emerald-700 text-white text-[11px] font-bold hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Verify payment
        </button>
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
      {msg && <p className="text-[10px] text-emerald-700 font-semibold w-full">{msg}</p>}
    </div>
  );
}
