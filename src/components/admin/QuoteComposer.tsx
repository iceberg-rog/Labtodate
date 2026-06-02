'use client';

import { useState, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Send, Lock, Mail, EyeOff, ChevronUp, ChevronDown, Paperclip, X } from 'lucide-react';
import { replyToQuote, sendProforma } from '@/lib/quotes/actions';

type Mode = 'reply' | 'internal' | 'proforma';
type Att = { url: string; name: string; type: string };

export function QuoteComposer({
  quoteId,
  buyerEmail,
  canSendProforma,
}: {
  quoteId: string;
  buyerEmail: string;
  canSendProforma: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('reply');
  const [open, setOpen] = useState(false);   // start COLLAPSED — workspace is conversation-first
  const [pending, start] = useTransition();
  const [body, setBody] = useState('');
  const [price, setPrice] = useState('');
  const [pnote, setPnote] = useState('');
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
        if (!res.ok) { setErr(data.error || 'Upload failed.'); continue; }
        if (data.url) setAtts((p) => p.length < 5 ? [...p, { url: data.url, name: data.name ?? 'file', type: data.type ?? '' }] : p);
      }
    } finally {
      setUploading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    start(async () => {
      try {
        if (mode === 'proforma') {
          const cents = Math.round(parseFloat(price) * 100);
          if (!Number.isFinite(cents) || cents <= 0) { setErr('Enter a valid price.'); return; }
          await sendProforma({
            sourcingRequestId: quoteId,
            priceCents: cents,
            currency: 'EUR',
            note: pnote.trim() || null,
          });
          setPrice(''); setPnote('');
        } else {
          if (body.trim().length < 2) { setErr('Message too short.'); return; }
          await replyToQuote({
            sourcingRequestId: quoteId,
            body: body.trim(),
            attachments: atts.map((a) => a.url),
            internal: mode === 'internal',
          });
          setBody(''); setAtts([]);
        }
        setOpen(false);
        router.refresh();
      } catch (e2) {
        if ((e2 as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setErr(e2 instanceof Error ? e2.message : 'Send failed.');
      }
    });
  }

  const isInternal = mode === 'internal';
  const isProforma = mode === 'proforma';

  // COLLAPSED: a calm bar with quick-reply prompts. Click expands the full composer.
  if (!open) {
    return (
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <button
          type="button"
          onClick={() => { setMode('reply'); setOpen(true); }}
          className="w-full p-3 text-left text-sm text-muted-foreground inline-flex items-center gap-3 hover:bg-foreground/[0.03] transition"
        >
          <span className="h-7 w-7 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center shrink-0">
            <Mail className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1">Reply to {buyerEmail}…</span>
          <ChevronUp className="h-4 w-4 opacity-50" />
        </button>
        <div className="px-3 pb-3 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => { setMode('internal'); setOpen(true); }}
            className="inline-flex items-center gap-1 h-7 px-3 rounded-full border border-amber-200 bg-amber-50 text-amber-900 text-[11px] font-bold hover:bg-amber-100"
          >
            <Lock className="h-3 w-3" /> Internal note
          </button>
          {canSendProforma && (
            <button
              type="button"
              onClick={() => { setMode('proforma'); setOpen(true); }}
              className="inline-flex items-center gap-1 h-7 px-3 rounded-full bg-accent text-accent-foreground text-[11px] font-bold hover:bg-accent/90"
            >
              <Send className="h-3 w-3" /> Send proforma
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section
      className={
        isInternal
          ? 'rounded-2xl border-2 border-amber-300 bg-amber-50/70 overflow-hidden'
          : isProforma
          ? 'rounded-2xl border-2 border-accent/40 bg-accent/[0.06] overflow-hidden'
          : 'rounded-2xl border-2 border-primary/40 bg-card overflow-hidden'
      }
    >
      <div className={`grid ${canSendProforma ? 'grid-cols-[1fr_1fr_1fr_auto]' : 'grid-cols-[1fr_1fr_auto]'} border-b border-border`}>
        <ModeTab active={mode === 'reply'} onClick={() => setMode('reply')} tone="primary" icon={<Mail className="h-4 w-4" />} label="Reply to buyer" />
        <ModeTab active={isInternal} onClick={() => setMode('internal')} tone="amber" icon={<Lock className="h-4 w-4" />} label="Internal note" />
        {canSendProforma && (
          <ModeTab active={isProforma} onClick={() => setMode('proforma')} tone="accent" icon={<Send className="h-4 w-4" />} label="Proforma" />
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 text-muted-foreground hover:text-foreground inline-flex items-center"
          aria-label="Collapse composer"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      <div
        className={
          isInternal
            ? 'px-5 py-2.5 bg-amber-100/80 border-b border-amber-200 inline-flex items-center gap-2 w-full'
            : isProforma
            ? 'px-5 py-2.5 bg-accent/[0.10] border-b border-accent/20 inline-flex items-center gap-2 w-full'
            : 'px-5 py-2.5 bg-primary/5 border-b border-primary/15 inline-flex items-center gap-2 w-full'
        }
      >
        {isInternal ? (
          <>
            <EyeOff className="h-3.5 w-3.5 text-amber-800 shrink-0" />
            <p className="text-[11px] font-semibold text-amber-900">Team-only — never emailed, never shown to {buyerEmail}.</p>
          </>
        ) : isProforma ? (
          <p className="text-[11px] font-semibold text-foreground">Sends a formal proforma invoice + payment instructions to {buyerEmail}.</p>
        ) : (
          <>
            <Mail className="h-3.5 w-3.5 text-primary shrink-0" />
            <p className="text-[11px] font-semibold text-primary">Emailed and shown to {buyerEmail}.</p>
          </>
        )}
      </div>

      <form onSubmit={submit} className="p-5 space-y-3">
        {isProforma ? (
          <>
            <label className="block">
              <span className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Price (EUR)</span>
              <div className="flex items-end gap-3 flex-wrap">
                <input
                  type="number" min="1" step="0.01"
                  value={price} onChange={(e) => setPrice(e.target.value)}
                  placeholder="18500.00"
                  required
                  className="h-10 w-48 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                />
                {(() => {
                  const cents = Math.round(parseFloat(price || '0') * 100);
                  return Number.isFinite(cents) && cents > 0 ? (
                    <div className="rounded-lg bg-accent/[0.10] border border-accent/30 px-3 py-1.5 text-xs">
                      <span className="text-muted-foreground">Buyer will see </span>
                      <strong className="tabular-nums">
                        {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100)}
                      </strong>
                    </div>
                  ) : null;
                })()}
              </div>
            </label>
            <label className="block">
              <span className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Note (optional)</span>
              <textarea
                value={pnote} onChange={(e) => setPnote(e.target.value.slice(0, 1500))}
                rows={3}
                placeholder="Lead time, condition, what's included, payment terms…"
                className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent"
                maxLength={1500}
              />
              <div className="text-right text-[10px] text-muted-foreground mt-1 tabular-nums">{pnote.length} / 1500</div>
            </label>
          </>
        ) : (
          <>
            {atts.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {atts.map((a, i) => (
                  <span key={a.url} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
                    <Paperclip className="h-3 w-3" />
                    <span className="max-w-[160px] truncate">{a.name}</span>
                    <button type="button" onClick={() => setAtts((p) => p.filter((_, j) => j !== i))} aria-label="Remove attachment">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              value={body} onChange={(e) => setBody(e.target.value.slice(0, 4000))}
              rows={4} required minLength={2}
              maxLength={4000}
              placeholder={isInternal ? 'Add an internal note — triage, hand-off, mention a teammate…' : 'Write a reply the buyer will see…'}
              className={
                isInternal
                  ? 'w-full px-3 py-2.5 rounded-lg border-2 border-amber-300 bg-white text-sm resize-y focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-500'
                  : 'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary'
              }
            />
            <div className="text-right text-[10px] text-muted-foreground tabular-nums">
              <span className={body.length > 3800 ? 'text-amber-600 font-semibold' : ''}>{body.length} / 4000</span>
            </div>
          </>
        )}

        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{err}</p>}

        <div className="flex items-center gap-2 flex-wrap">
          {!isProforma && (
            <label
              className="flex-shrink-0 h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted"
              title="Attach image or PDF"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Paperclip className="h-4 w-4 text-muted-foreground" />}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                multiple
                className="hidden"
                onChange={onFiles}
                disabled={uploading || atts.length >= 5}
              />
            </label>
          )}
          <span className="flex-1" />
          <button
            type="submit"
            disabled={pending}
            className={
              isInternal
                ? 'rounded-full bg-amber-500 hover:bg-amber-600 text-amber-950 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
                : isProforma
                ? 'rounded-full bg-accent text-accent-foreground hover:bg-accent/90 px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
                : 'rounded-full bg-primary hover:bg-primary/90 text-primary-foreground px-6 h-10 text-sm font-bold disabled:opacity-60 inline-flex items-center gap-2 shadow-sm'
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" />
              : isInternal ? <><Lock className="h-4 w-4" /> Post internal note</>
              : isProforma ? <><Send className="h-4 w-4" /> Send proforma</>
              : <><Send className="h-4 w-4" /> Send reply</>}
          </button>
        </div>
      </form>
    </section>
  );
}

function ModeTab({
  active, onClick, tone, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'primary' | 'amber' | 'accent';
  icon: JSX.Element;
  label: string;
}) {
  const activeCls =
    tone === 'amber' ? 'bg-amber-500 text-amber-950'
      : tone === 'accent' ? 'bg-accent text-accent-foreground'
      : 'bg-primary text-primary-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? `px-4 py-3 ${activeCls} font-bold text-sm inline-flex items-center justify-center gap-2`
          : 'px-4 py-3 bg-foreground/5 text-muted-foreground hover:bg-foreground/10 font-semibold text-sm inline-flex items-center justify-center gap-2'
      }
    >
      {icon}{label}
    </button>
  );
}
