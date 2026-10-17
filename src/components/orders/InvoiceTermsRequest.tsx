'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, FileClock } from 'lucide-react';
import { buyerRequestInvoiceTerms } from '@/app/app/orders/[orderNumber]/payment/actions';

/** "Pay on invoice (NET n)" — only rendered for buyers approved for credit within their limit. */
export function InvoiceTermsRequest({ orderNumber, termDays, summary }: { orderNumber: string; termDays: number; summary: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-6 space-y-2" data-testid="invoice-terms">
      <h2 className="text-lg font-bold inline-flex items-center gap-2"><FileClock className="h-5 w-5 text-primary" /> Pay on invoice (NET {termDays})</h2>
      <p className="text-sm text-muted-foreground">{summary} If our team approves, you receive the invoice with its due date instead of paying now.</p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm rounded-lg px-3 py-2 border ${msg.ok ? 'text-emerald-800 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800' : 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800'}`}>{msg.text}</p>}
      {!msg?.ok && (
        <button
          type="button"
          disabled={pending}
          onClick={() => start(async () => {
            try {
              const r = await buyerRequestInvoiceTerms({ orderNumber });
              setMsg({ ok: !r.error, text: r.error ?? r.notice ?? 'Request sent.' });
              if (!r.error) router.refresh();
            } catch {
              setMsg({ ok: false, text: 'The request failed — reload the page and try again.' });
            }
          })}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary text-primary px-5 py-2.5 text-sm font-semibold hover:bg-primary/5 disabled:opacity-60"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Ask to pay on invoice
        </button>
      )}
    </section>
  );
}
