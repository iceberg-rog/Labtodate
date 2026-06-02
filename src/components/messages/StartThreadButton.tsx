'use client';

import { useState, useTransition } from 'react';
import { MessageSquare, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { startThreadWithSeller } from '@/lib/messages/actions';

export function StartThreadButton({ productSlug, productTitle }: { productSlug: string; productTitle: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(`Hi — I'm interested in the ${productTitle}. Could you share more about availability, condition, and delivery?`);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const text = body.trim();
    if (text.length < 2) return;
    startTransition(async () => {
      try {
        await startThreadWithSeller({ productSlug, initialMessage: text });
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError(err instanceof Error ? err.message : 'Failed to send');
      }
    });
  }

  return (
    <>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="rounded-2xl font-semibold w-full">
        <MessageSquare className="h-4 w-4" /> Message seller
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-foreground/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-card border border-border p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold">Message the seller</h3>
                <p className="text-xs text-muted-foreground mt-1">They&apos;ll get an email and can reply in their inbox.</p>
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
                className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary resize-y"
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)} className="rounded-full font-medium">Cancel</Button>
                <Button type="submit" disabled={pending || body.trim().length < 2} className="rounded-full font-semibold">
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquare className="h-4 w-4" />} Send
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
