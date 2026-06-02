'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Webhook, Plus, Trash2, Power, PowerOff, Loader2, CheckCircle2, XCircle, Send } from 'lucide-react';
import { createWebhook, deleteWebhook, toggleWebhook, testWebhook } from '@/app/admin/actions';

type Hook = {
  id: string; name: string; kind: string; url: string; chatId: string | null;
  events: string[]; isActive: boolean; lastError: string | null; lastOkAt: string | null;
};

const ALL_EVENTS = [
  'ORDER_NEW', 'ORDER_PAID', 'ORDER_SHIPPED', 'ORDER_DELIVERED',
  'ORDER_CANCELED', 'ORDER_REFUNDED', 'SHIPPING_MISSING',
  'QUOTE_NEW', 'TICKET_NEW', 'SELL_NEW', 'ANNOUNCEMENT',
];

export function WebhooksPanel({ initial }: { initial: Hook[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hooks] = useState<Hook[]>(initial);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [kind, setKind] = useState<'SLACK' | 'DISCORD' | 'TELEGRAM'>('SLACK');

  function fireTest(id: string) {
    setTesting(id);
    setTestResult(null);
    start(async () => {
      try {
        const r = await testWebhook(id);
        setTestResult({ id, ...r });
      } catch (e) {
        setTestResult({ id, ok: false, message: e instanceof Error ? e.message : 'Test failed' });
      }
      setTesting(null);
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary inline-flex items-center gap-2">
          <Webhook className="h-4 w-4" /> Outbound webhooks
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Fan-out admin events to Slack / Discord / Telegram. Failures never break the originating action.
        </p>
      </div>

      {/* List */}
      <ul className="space-y-2">
        {hooks.length === 0 ? (
          <li className="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground text-center">
            No webhooks yet. Add one below to start mirroring admin events to a chat channel.
          </li>
        ) : hooks.map((h) => (
          <li key={h.id} className="rounded-xl border border-border bg-foreground/[0.02] p-3">
            <div className="flex items-start gap-3 flex-wrap">
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${
                h.kind === 'SLACK' ? 'bg-purple-50 text-purple-700 border-purple-200'
                : h.kind === 'DISCORD' ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                : 'bg-sky-50 text-sky-700 border-sky-200'
              }`}>{h.kind}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{h.name}</p>
                <p className="text-[10px] text-muted-foreground truncate font-mono">{h.url}</p>
                {h.chatId && <p className="text-[10px] text-muted-foreground">chat: <span className="font-mono">{h.chatId}</span></p>}
                <p className="text-[10px] text-muted-foreground mt-1">
                  Events: <span className="font-mono">{h.events.join(', ')}</span>
                </p>
                {h.lastError ? (
                  <p className="text-[11px] text-red-700 mt-1 inline-flex items-center gap-1">
                    <XCircle className="h-3 w-3" /> {h.lastError}
                  </p>
                ) : h.lastOkAt ? (
                  <p className="text-[11px] text-emerald-700 mt-1 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> last delivered {new Date(h.lastOkAt).toLocaleString()}
                  </p>
                ) : null}
                {testResult?.id === h.id && (
                  <p className={`text-[11px] mt-1 inline-flex items-center gap-1 font-semibold ${testResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>
                    {testResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                    {testResult.message}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => fireTest(h.id)}
                  disabled={pending}
                  className="inline-flex items-center gap-1 px-3 h-7 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold disabled:opacity-50"
                >
                  {testing === h.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  Test fire
                </button>
                <form
                  action={async () => {
                    await toggleWebhook(h.id, !h.isActive);
                    router.refresh();
                  }}
                >
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-2 h-6 rounded-full border border-border text-[10px] font-semibold hover:bg-foreground/5"
                  >
                    {h.isActive ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                    {h.isActive ? 'disable' : 'enable'}
                  </button>
                </form>
                <form
                  action={async () => {
                    if (confirm(`Delete webhook "${h.name}"?`)) {
                      await deleteWebhook(h.id);
                      router.refresh();
                    }
                  }}
                >
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-semibold text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3 w-3" /> delete
                  </button>
                </form>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Add new */}
      <form
        action={async (fd: FormData) => {
          try {
            await createWebhook(fd);
            router.refresh();
          } catch (e) {
            alert(e instanceof Error ? e.message : 'Failed to add webhook');
          }
        }}
        className="space-y-3 border-t border-border pt-4"
      >
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-2">
          <Plus className="h-3 w-3" /> Add webhook
        </h3>
        <div className="grid sm:grid-cols-[140px_1fr] gap-3">
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Kind</span>
            <select
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'SLACK' | 'DISCORD' | 'TELEGRAM')}
              className="w-full h-9 px-2 rounded-lg border border-input bg-background text-sm"
            >
              <option value="SLACK">Slack</option>
              <option value="DISCORD">Discord</option>
              <option value="TELEGRAM">Telegram</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Name</span>
            <input name="name" required maxLength={80} placeholder="#ops · Slack" className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm" />
          </label>
        </div>
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">
            {kind === 'TELEGRAM' ? 'Bot endpoint (https://api.telegram.org/bot<TOKEN>/sendMessage)' : 'Webhook URL'}
          </span>
          <input name="url" required type="url" placeholder={
            kind === 'SLACK' ? 'https://hooks.slack.com/services/...'
            : kind === 'DISCORD' ? 'https://discord.com/api/webhooks/...'
            : 'https://api.telegram.org/bot<token>/sendMessage'
          } className="w-full h-9 px-3 rounded-lg border border-input bg-background text-xs font-mono" />
        </label>
        {kind === 'TELEGRAM' && (
          <label className="block">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Telegram chat_id</span>
            <input name="chatId" placeholder="-1001234567890" className="w-full h-9 px-3 rounded-lg border border-input bg-background text-xs font-mono" />
          </label>
        )}
        <label className="block">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Events filter</span>
          <input name="events" defaultValue="*" placeholder="* or ORDER_PAID, SHIPPING_MISSING, …" className="w-full h-9 px-3 rounded-lg border border-input bg-background text-xs font-mono" />
          <span className="text-[10px] text-muted-foreground mt-1 block">
            <code className="font-mono">*</code> = everything · or comma-list from: <span className="font-mono">{ALL_EVENTS.join(', ')}</span>
          </span>
        </label>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold"
        >
          <Plus className="h-3.5 w-3.5" /> Add webhook
        </button>
      </form>
    </div>
  );
}
