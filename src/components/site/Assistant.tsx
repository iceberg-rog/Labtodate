'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  MessageCircle, X, Send, Loader2, ShieldCheck, Sparkles, UserCircle2,
  Paperclip, Star, Headphones, Check,
} from 'lucide-react';
import {
  sendAssistantMessage,
  requestHumanEscalation,
  rateAssistantConversation,
  getOrInitConversation,
  startFreshConversation,
} from '@/lib/assistant/actions';

type WireMsg = { id: string; role: string; body: string; attachments: string[]; createdAt: string };
type Identity = { kind: 'user' | 'guest'; name: string | null; email: string | null };

/**
 * Public chat widget. Renders a floating bubble bottom-right; opens a
 * 380-wide panel with the active conversation. State lives in the
 * database so reloads/devices/sessions all see the same thread (guest
 * identification via signed cookie; logged-in via session).
 *
 * Lifecycle states (driven by the server, surfaced via `status`):
 *   AI              — assistant is replying
 *   AWAITING_HUMAN  — user asked for human, no admin yet
 *   WITH_HUMAN      — admin is replying
 *   CLOSED          — admin closed; show rating CTA
 *   ARCHIVED        — terminal (rated or auto-archived) — start fresh
 *
 * The widget polls when WITH_HUMAN so an admin reply appears within
 * a couple of seconds without WS infrastructure.
 */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<WireMsg[]>([]);
  const [status, setStatus] = useState<string>('AI');
  const [rating, setRating] = useState<number | null>(null);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity>({ kind: 'guest', name: null, email: null });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showEscalate, setShowEscalate] = useState(false);
  const [escName, setEscName] = useState('');
  const [escEmail, setEscEmail] = useState('');
  const [stars, setStars] = useState(0);
  const [ratingNote, setRatingNote] = useState('');
  const [ratingSent, setRatingSent] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply a snapshot returned by an action.
  const applySnapshot = useCallback((snap: { messages: WireMsg[]; status: string; rating: number | null; closedAt: string | null }) => {
    setMsgs(snap.messages);
    setStatus(snap.status);
    setRating(snap.rating);
    setClosedAt(snap.closedAt);
  }, []);

  // Refetch state every time the widget opens. Previously we only loaded
  // once per page-life (initRef gate) which meant: admin closes the chat
  // → customer reopens widget later → they STILL see the stale open
  // conversation with no rating prompt. Refetch-on-open guarantees the
  // user sees whatever state the server has right now.
  useEffect(() => {
    if (!open) return;
    setRatingSent(false); // re-enable rating UI on any fresh open
    (async () => {
      try {
        const snap = await getOrInitConversation();
        setIdentity(snap.identity);
        applySnapshot(snap);
        if (snap.messages.length === 0 && snap.status === 'AI') {
          // Brand-new conversation — show the greeting locally without
          // persisting; the first real user message starts AI history.
          setMsgs([{ id: 'greet', role: 'assistant', body: 'Hi! I can help with buying, quotes, selling, orders and shipping on lab2date. What do you need?', attachments: [], createdAt: new Date().toISOString() }]);
        }
      } catch (e) {
        console.error('chat init failed', e);
      }
    })();
  }, [open, applySnapshot]);

  // Auto-scroll to bottom on new message.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, open, status]);

  // Keep polling for any non-terminal status so the customer sees admin
  // replies + the admin-close transition (which flips into the rating UI).
  // We stop only once the conversation is ARCHIVED.
  useEffect(() => {
    if (!open) return;
    if (status === 'ARCHIVED') return;
    const tick = async () => {
      try {
        const snap = await getOrInitConversation();
        applySnapshot(snap);
      } catch {}
      pollRef.current = setTimeout(tick, 5000);
    };
    pollRef.current = setTimeout(tick, 5000);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [open, status, applySnapshot]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || busy) return;
    setBusy(true);
    setInput('');
    // optimistic
    setMsgs((m) => [...m.filter((x) => x.id !== 'greet'), {
      id: `local-${Date.now()}`,
      role: 'user',
      body: text,
      attachments: pendingAttachments,
      createdAt: new Date().toISOString(),
    }]);
    try {
      const snap = await sendAssistantMessage({ body: text, attachments: pendingAttachments });
      applySnapshot(snap);
    } catch (err) {
      console.error('send failed', err);
      setMsgs((m) => [...m, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        body: 'Network hiccup — please try again.',
        attachments: [],
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setBusy(false);
      setPendingAttachments([]);
    }
  }

  async function escalate() {
    if (busy) return;
    setBusy(true);
    try {
      await requestHumanEscalation({
        name: identity.kind === 'guest' ? escName.trim() || undefined : undefined,
        email: identity.kind === 'guest' ? escEmail.trim() || undefined : undefined,
      });
      const snap = await getOrInitConversation();
      applySnapshot(snap);
      setShowEscalate(false);
    } finally {
      setBusy(false);
    }
  }

  async function submitRating() {
    if (!stars) return;
    setBusy(true);
    try {
      await rateAssistantConversation({ rating: stars, note: ratingNote.trim() || undefined });
      setRatingSent(true);
      // Reset the local copy — server returns a fresh ARCHIVED state which
      // means next open spawns a new conversation.
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setAttaching(true);
    try {
      const uploaded: string[] = [];
      for (const f of files) {
        if (pendingAttachments.length + uploaded.length >= 4) break;
        if (f.size > 8_000_000) continue;
        if (!/^image\//.test(f.type) && f.type !== 'application/pdf') continue;
        const fd = new FormData();
        fd.append('file', f);
        const r = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await r.json().catch(() => ({}));
        if (data.url) uploaded.push(data.url);
      }
      if (uploaded.length > 0) setPendingAttachments((cur) => [...cur, ...uploaded].slice(0, 4));
    } finally {
      setAttaching(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open assistant"
          className="fixed bottom-5 right-5 z-[80] h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}
      {open && (
        <div className="fixed bottom-5 right-5 z-[80] w-[92vw] max-w-sm h-[72vh] max-h-[600px] rounded-2xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-primary-foreground">
            <div className="flex items-center gap-2">
              {status === 'WITH_HUMAN' ? <Headphones className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
              <span className="font-semibold text-sm">
                {status === 'WITH_HUMAN' ? 'lab2date · live agent' : status === 'AWAITING_HUMAN' ? 'lab2date · connecting…' : 'lab2date Assistant'}
              </span>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Identity strip */}
          <div className="px-4 py-2 bg-foreground/[0.03] border-b border-border text-[11px] text-muted-foreground flex items-center gap-2">
            <UserCircle2 className="h-3.5 w-3.5" />
            {identity.kind === 'user'
              ? <>Signed in as <strong className="text-foreground">{identity.name}</strong></>
              : <>Browsing as guest</>
            }
            {status === 'AWAITING_HUMAN' && <span className="ml-auto inline-flex items-center gap-1 text-amber-700 font-semibold"><Loader2 className="h-3 w-3 animate-spin" /> Finding an agent…</span>}
            {status === 'WITH_HUMAN' && <span className="ml-auto inline-flex items-center gap-1 text-emerald-700 font-semibold"><ShieldCheck className="h-3 w-3" /> Live</span>}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-foreground/[0.02]">
            {msgs.map((m) => <Bubble key={m.id} m={m} />)}
            {busy && (
              <div className="bg-card border border-border rounded-2xl px-3.5 py-2 text-sm w-fit">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Escalate flow / Rating flow / Composer */}
          {showEscalate ? (
            <div className="p-3 border-t border-border bg-amber-50 space-y-2">
              <p className="text-xs font-bold text-amber-900">Connect me with a human</p>
              {identity.kind === 'guest' && (
                <>
                  <input value={escName} onChange={(e) => setEscName(e.target.value)} placeholder="Your name (optional)" className="w-full h-9 px-2 rounded-md border border-input bg-white text-sm" />
                  <input value={escEmail} onChange={(e) => setEscEmail(e.target.value)} type="email" placeholder="Email (so we can follow up)" className="w-full h-9 px-2 rounded-md border border-input bg-white text-sm" />
                </>
              )}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowEscalate(false)} className="text-xs font-semibold text-muted-foreground hover:text-foreground h-8 px-3">Cancel</button>
                <button type="button" onClick={escalate} disabled={busy} className="text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white rounded-full h-8 px-3 inline-flex items-center gap-1.5">
                  <Headphones className="h-3.5 w-3.5" /> Request human
                </button>
              </div>
            </div>
          ) : status === 'CLOSED' && !ratingSent ? (
            <div className="p-3 border-t border-border bg-emerald-50/60 space-y-2">
              <p className="text-xs font-bold text-emerald-900">How was your chat? Rate us:</p>
              <div className="flex items-center justify-center gap-1.5">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button key={s} type="button" onClick={() => setStars(s)} aria-label={`${s} stars`} className="p-1">
                    <Star className={`h-6 w-6 ${stars >= s ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground'}`} />
                  </button>
                ))}
              </div>
              <textarea value={ratingNote} onChange={(e) => setRatingNote(e.target.value)} rows={2} placeholder="Anything we could do better? (optional)" className="w-full px-2 py-1.5 rounded-md border border-input bg-white text-xs" maxLength={500} />
              <button type="button" onClick={submitRating} disabled={busy || stars === 0} className="w-full h-9 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold disabled:opacity-50">
                Submit rating
              </button>
            </div>
          ) : status === 'CLOSED' && ratingSent ? (
            <div className="p-4 border-t border-border bg-emerald-50/60 text-center space-y-3">
              <Check className="h-6 w-6 text-emerald-700 mx-auto" />
              <p className="text-xs text-emerald-900">Thanks — rating submitted!</p>
              <button
                type="button"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const snap = await startFreshConversation();
                    applySnapshot(snap);
                    setIdentity(snap.identity);
                    setRatingSent(false);
                    setStars(0);
                    setRatingNote('');
                    setMsgs([{ id: 'greet', role: 'assistant', body: 'Hi! Fresh chat — how can I help?', attachments: [], createdAt: new Date().toISOString() }]);
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
                className="w-full h-9 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                <MessageCircle className="h-4 w-4" /> Start a new chat
              </button>
            </div>
          ) : status === 'ARCHIVED' ? (
            <div className="p-4 border-t border-border bg-foreground/[0.03] text-center space-y-3">
              <p className="text-xs text-muted-foreground">This conversation is closed.</p>
              <button
                type="button"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const snap = await startFreshConversation();
                    applySnapshot(snap);
                    setIdentity(snap.identity);
                    setRatingSent(false);
                    setStars(0);
                    setRatingNote('');
                    setMsgs([{ id: 'greet', role: 'assistant', body: 'Hi! Fresh chat — how can I help?', attachments: [], createdAt: new Date().toISOString() }]);
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
                className="w-full h-9 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                <MessageCircle className="h-4 w-4" /> Start a new chat
              </button>
            </div>
          ) : (
            <>
              {/* pending attachments preview */}
              {pendingAttachments.length > 0 && (
                <div className="px-3 pt-2 flex gap-2 flex-wrap">
                  {pendingAttachments.map((url) => (
                    /^data:|^https?:/.test(url) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={url} src={url} alt="" className="h-12 w-12 rounded-md object-cover border border-border" />
                    ) : (
                      <span key={url} className="inline-flex items-center gap-1 text-[10px] bg-muted rounded-full px-2 py-1">
                        <Paperclip className="h-3 w-3" /> file
                      </span>
                    )
                  ))}
                </div>
              )}
              <form onSubmit={send} className="p-3 border-t border-border flex gap-2 items-center">
                <label className="h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted" title="Attach image or PDF">
                  {attaching ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Paperclip className="h-4 w-4 text-muted-foreground" />}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple className="hidden" onChange={onFiles} disabled={attaching || pendingAttachments.length >= 4} />
                </label>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={status === 'WITH_HUMAN' ? 'Message the agent…' : 'Ask anything…'}
                  className="flex-1 h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button type="submit" disabled={busy} className="h-10 w-10 rounded-lg bg-primary text-primary-foreground flex items-center justify-center disabled:opacity-50">
                  <Send className="h-4 w-4" />
                </button>
              </form>
              {(status === 'AI' || status === 'AWAITING_HUMAN' || status === 'WITH_HUMAN') && (
                <div className="px-3 pb-3 -mt-1">
                  {status === 'AI' && (
                    <button type="button" onClick={() => setShowEscalate(true)} className="w-full text-[11px] font-semibold text-primary hover:underline inline-flex items-center justify-center gap-1">
                      <Headphones className="h-3 w-3" /> Talk to a human instead
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

function Bubble({ m }: { m: WireMsg }) {
  if (m.role === 'system') {
    return (
      <div className="flex items-center gap-2 my-1">
        <div className="flex-1 h-px bg-border" />
        <p className="text-[10px] text-muted-foreground font-medium">{m.body}</p>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }
  const isUser = m.role === 'user';
  const isAdmin = m.role === 'admin';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`h-7 w-7 rounded-full inline-flex items-center justify-center flex-shrink-0 shadow-sm text-[10px] font-bold ${
        isUser
          ? 'bg-primary text-primary-foreground'
          : isAdmin
          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
          : 'bg-violet-100 text-violet-800 border border-violet-200'
      }`}>
        {isUser ? 'You' : isAdmin ? <ShieldCheck className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
      </div>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
        isUser
          ? 'bg-primary text-primary-foreground rounded-tr-sm'
          : isAdmin
          ? 'bg-emerald-50 border border-emerald-200 rounded-tl-sm'
          : 'bg-card border border-border rounded-tl-sm'
      }`}>
        {m.body}
        {m.attachments.length > 0 && (
          <div className="mt-2 flex gap-2 flex-wrap">
            {m.attachments.map((url) => (
              /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt="" className="h-20 w-20 rounded-md object-cover border border-border" />
                </a>
              ) : (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] underline">
                  <Paperclip className="h-3 w-3" /> attachment
                </a>
              )
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
