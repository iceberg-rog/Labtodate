'use client';

import { useState, useTransition } from 'react';
import { Loader2, Send } from 'lucide-react';
import { resendOrderDocuments } from '@/app/admin/documents/order-actions';

/** Re-sends the "payment received" e-mail with the same invoice/receipt PDFs. */
export function ResendDocumentsButton({ orderId }: { orderId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!confirm('E-mail the invoice (and receipt) to the buyer again? The documents stay the same.')) return;
          start(async () => setMsg((await resendOrderDocuments(orderId)).message));
        }}
        className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5 disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Re-send to buyer
      </button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
