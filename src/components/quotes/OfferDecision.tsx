'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, X } from 'lucide-react';
import { setQuoteStatus } from '@/lib/quotes/actions';

/**
 * The buyer's decision on a formal offer (proforma). Nothing is ordered until
 * the buyer accepts: accepting creates the order and opens the purchase
 * workspace; declining ends the quote and tells the Labtodate team.
 */
export function OfferDecision({ quoteId, amountLabel }: { quoteId: string; amountLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(status: 'ACCEPTED' | 'DECLINED') {
    const question =
      status === 'ACCEPTED'
        ? `Accept this offer for ${amountLabel}? This places your order. You will then confirm the delivery address and pay by bank transfer.`
        : 'Decline this offer? The quote is closed and our team is told. You can always open a new request.';
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await setQuoteStatus(quoteId, status);
        if (r?.error) {
          setError(r.error);
          return;
        }
        router.refresh();
      } catch (err) {
        // Accepting redirects to the purchase workspace — not an error.
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError('That did not work. Reload the page and try again.');
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2 flex-wrap justify-end">
        <button
          type="button"
          onClick={() => decide('ACCEPTED')}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
          Accept offer
        </button>
        <button
          type="button"
          onClick={() => decide('DECLINED')}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60"
        >
          <X className="h-4 w-4" aria-hidden /> Decline
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 dark:text-red-400 dark:bg-red-950/40 dark:border-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
