'use client';

import { useState, useTransition } from 'react';
import { MessageSquare, Loader2, X, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { startThreadWithSeller } from '@/lib/messages/actions';
import { askAboutProduct, type ProductQuestionKind } from '@/lib/catalog/product-question';

/**
 * Contact about a listing.
 *  - channel SELLER: a marketplace seller with a real account → buyer ↔ seller thread.
 *  - channel TEAM:   lab2date is the seller of record (imported items) → a
 *    support ticket to the lab2date team ("Request photos" is the same with
 *    kind PHOTOS). Never a quote request.
 */
export function StartThreadButton({
  productSlug,
  productTitle,
  label,
  initialMessage,
  channel = 'SELLER',
  kind = 'QUESTION',
  teamName = 'Labtodate',
  minChars = 2,
}: {
  productSlug: string;
  productTitle: string;
  label?: string;
  initialMessage?: string;
  channel?: 'SELLER' | 'TEAM';
  kind?: ProductQuestionKind;
  teamName?: string;
  minChars?: number;
}) {
  const team = channel === 'TEAM';
  const photos = team && kind === 'PHOTOS';
  const buttonLabel = label ?? (team ? 'Ask a question about this unit' : 'Message seller');
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(
    initialMessage ?? `Hi — I'm interested in the ${productTitle}. Could you share more about availability, condition, and delivery?`,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const min = Math.max(2, minChars);
  const length = body.trim().length;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (text.length < min) {
      setError(`Write at least ${min} characters.`);
      return;
    }
    startTransition(async () => {
      try {
        const res = team
          ? await askAboutProduct({ productSlug, message: text, kind })
          : await startThreadWithSeller({ productSlug, initialMessage: text });
        if (res?.error) setError(res.error);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError('Your message was not sent. Reload the page and try again.');
      }
    });
  }

  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="rounded-2xl font-semibold w-full">
        {photos ? <Camera className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />} {buttonLabel}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-foreground/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="thread-dialog-title">
          <div className="w-full max-w-md rounded-2xl bg-card border border-border p-6 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="thread-dialog-title" className="text-lg font-bold">
                  {photos ? buttonLabel : team ? `Ask ${teamName} about this unit` : 'Message the seller'}
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {team
                    ? `Your ${photos ? 'request' : 'question'} goes to the ${teamName} team, the seller of this unit. We reply by email and under Support in your account.`
                    : 'We notify the seller and email you when they reply.'}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={submit} className="mt-4 space-y-3">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                minLength={min}
                maxLength={4000}
                aria-label={photos ? 'Your photo request' : 'Your message'}
                className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
              />
              <p className={`text-[11px] ${length < min ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                {length < min ? `At least ${min} characters (${length} so far).` : `${length} / 4,000 characters`}
              </p>
              {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="rounded-full font-medium">Cancel</Button>
                <Button type="submit" disabled={pending || length < min} className="rounded-full font-semibold">
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : photos ? <Camera className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />} Send
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
