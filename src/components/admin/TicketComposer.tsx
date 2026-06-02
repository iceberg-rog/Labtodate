'use client';

import { useRef, useState, useTransition } from 'react';
import { Paperclip, X, Loader2, Lock, Send, Mail, EyeOff } from 'lucide-react';
import { replyTicket } from '@/lib/support/actions';

type Att = { url: string; name: string; type: string };
type Mode = 'reply' | 'internal';

export function TicketComposer({
  ticketId,
  customerEmail,
}: {
  ticketId: string;
  customerEmail: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<Mode>('reply');
  const [pending, start] = useTransition();
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      for (const f of files) {
        if (atts.length >= 5) break;
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(data.error || 'Upload failed.');
          continue;
        }
        if (data.url) {
          setAtts((p) =>
            p.length < 5 ? [...p, { url: data.url, name: data.name ?? 'file', type: data.type ?? '' }] : p,
          );
        }
      }
    } finally {
      setUploading(false);
    }
  }

  const isInternal = mode === 'internal';

  return (
    <section
      className={
        isInternal
          ? 'rounded-2xl border-2 border-amber-300 bg-amber-50/70 overflow-hidden transition-colors'
          : 'rounded-2xl border-2 border-primary/40 bg-card overflow-hidden transition-colors'
      }
    >
      {/* Mode toggle — large, unmissable */}
      <div className="grid grid-cols-2 border-b border-border">
        <button
          type="button"
          onClick={() => setMode('reply')}
          className={
            mode === 'reply'
              ? 'px-4 py-3 bg-primary text-primary-foreground font-bold text-sm inline-flex items-center justify-center gap-2'
              : 'px-4 py-3 bg-foreground/5 text-muted-foreground hover:bg-foreground/10 font-semibold text-sm inline-flex items-center justify-center gap-2'
          }
        >
          <Mail className="h-4 w-4" />
          Reply to customer
        </button>
        <button
          type="button"
          onClick={() => setMode('internal')}
          className={
            mode === 'internal'
              ? 'px-4 py-3 bg-amber-500 text-amber-950 font-bold text-sm inline-flex items-center justify-center gap-2'
              : 'px-4 py-3 bg-foreground/5 text-muted-foreground hover:bg-foreground/10 font-semibold text-sm inline-flex items-center justify-center gap-2'
          }
        >
          <Lock className="h-4 w-4" />
          Internal note
        </button>
      </div>

      {/* Mode banner — tells operator the consequence */}
      <div
        className={
          isInternal
            ? 'px-5 py-2.5 bg-amber-100/80 border-b border-amber-200 inline-flex items-center gap-2 w-full'
            : 'px-5 py-2.5 bg-primary/5 border-b border-primary/15 inline-flex items-center gap-2 w-full'
        }
      >
        {isInternal ? (
          <>
            <EyeOff className="h-3.5 w-3.5 text-amber-800 shrink-0" />
            <p className="text-[11px] font-semibold text-amber-900">
              Team-only — never emailed, never shown to {customerEmail}.
            </p>
          </>
        ) : (
          <>
            <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
            <p className="text-[11px] font-semibold text-primary">
              Emailed and shown to {customerEmail}.
            </p>
          </>
        )}
      </div>

      <div className="p-5">
        {atts.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-3">
            {atts.map((a, i) => (
              <span
                key={a.url}
                className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs"
              >
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[160px] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => setAtts((p) => p.filter((_, j) => j !== i))}
                  aria-label="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

        <form
          ref={ref}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set('attachments', JSON.stringify(atts.map((a) => a.url)));
            fd.set('ticketId', ticketId);
            if (isInternal) fd.set('internal', '1');
            const form = e.currentTarget;
            start(async () => {
              try {
                await replyTicket(fd);
                form.reset();
                setAtts([]);
              } catch (er) {
                if ((er as Error)?.message?.includes('NEXT_REDIRECT')) {
                  form.reset();
                  setAtts([]);
                  return;
                }
                setErr((er as Error)?.message ?? 'Send failed.');
              }
            });
          }}
          className="space-y-3"
        >
          <textarea
            name="body"
            required
            rows={4}
            placeholder={
              isInternal
                ? 'Add an internal note — triage, hand-off, mention a teammate…'
                : 'Write a reply the customer will see…'
            }
            className={
              isInternal
                ? 'w-full px-3 py-2.5 rounded-lg border-2 border-amber-300 bg-white text-sm resize-y focus:outline-none focus:border-amber-500'
                : 'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:border-primary'
            }
          />
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="flex-shrink-0 h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted"
              title="Attach image or PDF"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Paperclip className="h-4 w-4 text-muted-foreground" />
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                multiple
                className="hidden"
                onChange={onFiles}
                disabled={uploading || atts.length >= 5}
              />
            </label>
            <span className="flex-1" />
            <button
              type="submit"
              disabled={pending}
              className={
                isInternal
                  ? 'rounded-full bg-amber-500 hover:bg-amber-600 text-amber-950 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
                  : 'rounded-full bg-primary hover:bg-primary/90 text-primary-foreground px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
              }
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isInternal ? (
                <>
                  <Lock className="h-4 w-4" />
                  Post internal note
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  Send reply
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
