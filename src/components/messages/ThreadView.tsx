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
}

export function ThreadView({
  threadId,
  initialMessages,
  otherParty,
  productTitle,
  productSlug,
}: {
  threadId: string;
  initialMessages: Msg[];
  otherParty: { name: string; role: 'buyer' | 'seller' };
  productTitle?: string;
  productSlug?: string;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [body, setBody] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
            // Append only ones we don't already have
            const known = new Set(prev.map((m) => m.id));
            const merged = [...prev, ...incoming.filter((m) => !known.has(m.id))];
            return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    startTransition(async () => {
      try {
        await sendMessage({ threadId, body: text });
        setBody('');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Send failed');
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
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{m.body}</p>
            <p className={`text-[10px] mt-1 ${m.isMine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
              {new Date(m.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form onSubmit={handleSend} className="mt-4 flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 h-11 px-4 rounded-2xl border border-input bg-card text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
        <Button type="submit" disabled={pending || !body.trim()} className="rounded-2xl font-semibold">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
