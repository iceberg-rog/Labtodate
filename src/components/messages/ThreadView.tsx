'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Send, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sendMessage } from '@/lib/messages/actions';

interface Msg {
  id: string;
  body: string;
  createdAt: string;
  authorName: string | null;
  authorEmail: string | null;
  isMine: boolean;
  /** Delivery note on the viewer's own message (waiting for staff review / not delivered). */
  note?: string | null;
}

export function ThreadView({
  threadId,
  initialMessages,
  otherParty,
  productTitle,
  productSlug,
  notice,
  closed,
}: {
  threadId: string;
  initialMessages: Msg[];
  otherParty: { name: string; role: 'buyer' | 'seller' };
  productTitle?: string;
  productSlug?: string;
  /** How the conversation is mediated (shown under the header). */
  notice?: string;
  /** The conversation moved elsewhere (a support ticket): a link instead of the composer. */
  closed?: { href: string; label: string };
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Polling for new messages every 5s.
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const since = messages[messages.length - 1]?.createdAt;
      try {
        const url = `/api/threads/${threadId}/messages${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const incoming: Msg[] = data.messages ?? [];
        if (incoming.length > 0) {
          setMessages((prev) => {
            // New ones are appended; known ones are replaced (a held message
            // that staff released comes back with its new state).
            const byId = new Map(prev.map((m) => [m.id, m]));
            for (const m of incoming) byId.set(m.id, m);
            return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          });
        }
      } catch {
        // network blip — ignore
      }
    }
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [threadId, messages]);

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setError(null);
    setInfo(null);
    startTransition(async () => {
      try {
        const res = await sendMessage({ threadId, body: text });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setBody('');
        if (res.notice) setInfo(res.notice);
        if (res.movedTo) {
          router.push(res.movedTo);
          return;
        }
        const sent = res.message;
        if (sent) setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
        router.refresh();
      } catch {
        setError('Your message was not sent. Reload the page and try again.');
      }
    });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      <div className="rounded-2xl border border-border bg-card p-4 mb-4 flex items-center gap-3">
        <Link href="/app/inbox" className="text-muted-foreground hover:text-foreground" aria-label="Back to inbox">
          <ChevronLeft className="h-4 w-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground">
            {otherParty.role === 'seller' ? 'Seller' : 'Buyer'}
          </p>
          <p className="font-semibold text-sm truncate">{otherParty.name}</p>
        </div>
        {productTitle && productSlug && (
          <Link
            href={`/marketplace/${productSlug}`}
            className="text-xs text-muted-foreground hover:text-foreground truncate max-w-[40%] hidden sm:block"
          >
            About: {productTitle}
          </Link>
        )}
      </div>
      {notice && <p className="text-[11px] text-muted-foreground -mt-2 mb-3 px-1">{notice}</p>}

      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[80%] rounded-2xl px-4 py-2.5 ${
              m.isMine
                ? 'bg-primary text-primary-foreground ml-auto'
                : 'bg-card border border-border'
            }`}
          >
            {!m.isMine && m.authorName && m.authorName !== otherParty.name && (
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">{m.authorName}</p>
            )}
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.body}</p>
            {m.note && <p className={`text-[11px] mt-1 italic ${m.isMine ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{m.note}</p>}
            <p className={`text-[10px] mt-1 ${m.isMine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
              {new Date(m.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {closed ? (
        <Button asChild className="mt-4 rounded-2xl font-semibold">
          <Link href={closed.href}>{closed.label}</Link>
        </Button>
      ) : (
      <form onSubmit={handleSend} className="mt-4 flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 h-11 px-4 rounded-2xl border border-input bg-card text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
        <Button type="submit" disabled={pending || !body.trim()} className="rounded-2xl font-semibold" aria-label="Send message">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
      )}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
      {info && <p role="status" className="text-xs text-muted-foreground mt-2">{info}</p>}
    </div>
  );
}
