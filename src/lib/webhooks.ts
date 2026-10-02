import { prisma } from '@/lib/db';
import { safeFetch } from '@/lib/import/safe-fetch';

/**
 * Outbound notification kinds. Used both as Notification.kind in the DB and
 * as the event filter that WebhookConfig.events can subscribe to. '*' on
 * WebhookConfig means subscribe to everything.
 */
export const NOTIFY_KINDS = [
  'ORDER_NEW',            // a new (still unpaid) order was created
  'ORDER_PAID',           // payment confirmed (kept for back-compat across legacy emit sites)
  'ORDER_SHIPPED',        // admin marked shipped
  'ORDER_DELIVERED',      // admin marked delivered
  'ORDER_CANCELED',       // canceled before payment
  'ORDER_REFUNDED',       // refunded after payment
  'SHIPPING_MISSING',     // PAID order with no shipping address
  'PAYMENT_SUBMITTED',    // buyer uploaded a payment proof — admin to review
  'PAYMENT_VERIFIED',     // admin verified a buyer-submitted proof
  'PAYMENT_REJECTED',     // admin rejected; buyer asked to resubmit
  'QUOTE_NEW',            // new sourcing request
  'QUOTE_APPROVED',       // proforma sent (priced) — buyer should see it
  'ORDER_FROM_QUOTE',     // quote accepted → Order auto-created
  'TICKET_NEW',           // new support ticket
  'SELL_NEW',             // new sell submission
  'ANNOUNCEMENT',         // manual broadcast
  'SYSTEM',               // generic / catch-all
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Absolute URL for webhook payloads. trailing slash stripped. */
function siteUrl(): string {
  return (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function shortKind(k: NotifyKind): string {
  return k.replace(/_/g, ' ').toLowerCase();
}

/** Render a webhook payload appropriate to its destination. */
function buildPayload(
  kind: NotifyKind,
  title: string,
  body: string,
  href: string,
  destKind: string,
  chatId: string | null,
): { url?: string; body: string; contentType: string } | null {
  const fullUrl = href.startsWith('http') ? href : `${siteUrl()}${href}`;
  const tag = shortKind(kind);

  if (destKind === 'SLACK') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        text: `*[${tag}]* ${title}`,
        attachments: [
          {
            color: kind.startsWith('ORDER_REFUNDED') || kind === 'SHIPPING_MISSING'
              ? '#dc2626'
              : kind === 'ORDER_PAID'
                ? '#059669'
                : '#0E4F40',
            text: body,
            actions: [{ type: 'button', text: 'Open', url: fullUrl }],
          },
        ],
      }),
    };
  }

  if (destKind === 'DISCORD') {
    return {
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'lab2date',
        embeds: [
          {
            title: `[${tag}] ${title}`,
            description: `${body}\n\n[Open →](${fullUrl})`,
            color:
              kind === 'ORDER_REFUNDED' || kind === 'SHIPPING_MISSING'
                ? 0xdc2626
                : kind === 'ORDER_PAID'
                  ? 0x059669
                  : 0x0e4f40,
          },
        ],
      }),
    };
  }

  if (destKind === 'TELEGRAM') {
    // For Telegram, `url` is the bot endpoint (https://api.telegram.org/bot<TOKEN>/sendMessage)
    // and chatId is mandatory.
    if (!chatId) return null;
    const text = `*[${tag}]* ${title}\n${body}\n\n${fullUrl}`;
    return {
      contentType: 'application/json',
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: false }),
    };
  }

  return null;
}

type HookRow = { id: string; kind: string; url: string; chatId: string | null; events: string[] };

/**
 * POST one event to ONE hook and record lastOkAt / lastError on its row.
 * Goes through the SSRF-guarded safeFetch (no private / loopback / metadata
 * addresses, no redirects) — a webhook URL is admin-typed and must not be a
 * way to make the server call internal services. Never throws.
 */
async function deliverToHook(
  h: HookRow,
  kind: NotifyKind,
  title: string,
  body: string,
  href: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = buildPayload(kind, title, body, href, h.kind, h.chatId);
  if (!p) {
    const error = h.kind === 'TELEGRAM' ? 'Telegram hook has no chat_id.' : `Unknown webhook kind ${h.kind}.`;
    try { await prisma.webhookConfig.update({ where: { id: h.id }, data: { lastError: error } }); } catch {/* ignore */}
    return { ok: false, error };
  }
  let error: string | null = null;
  try {
    const r = await safeFetch(h.url, {
      post: { body: p.body, contentType: p.contentType },
      timeoutMs: 8000,
      maxBytes: 64 * 1024,
    });
    if (r.status < 200 || r.status >= 300) error = `HTTP ${r.status}: ${r.body.slice(0, 200)}`;
  } catch (e) {
    error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  try {
    await prisma.webhookConfig.update({
      where: { id: h.id },
      data: error ? { lastError: error } : { lastOkAt: new Date(), lastError: null },
    });
  } catch {/* nested swallow */}
  return error ? { ok: false, error } : { ok: true };
}

/** Dispatch an event to every active matching webhook. Fail-safe. */
export async function dispatchWebhook(
  kind: NotifyKind,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  let hooks: HookRow[] = [];
  try {
    hooks = await prisma.webhookConfig.findMany({
      where: { isActive: true },
      select: { id: true, kind: true, url: true, chatId: true, events: true },
    });
  } catch {
    return; // table may not exist yet (pre-migration); silent
  }
  if (hooks.length === 0) return;

  // Fan-out in parallel; don't await failures.
  await Promise.allSettled(
    hooks
      .filter((h) => h.events.includes('*') || h.events.includes(kind))
      .map((h) => deliverToHook(h, kind, title, body, href)),
  );
}

/** Test-fire: send a synthetic ANNOUNCEMENT to exactly ONE hook (ignoring its
 *  event filter) and report that hook's own response. */
export async function sendTestWebhook(id: string): Promise<{ ok: boolean; error?: string } | null> {
  const h = await prisma.webhookConfig.findUnique({
    where: { id },
    select: { id: true, kind: true, url: true, chatId: true, events: true },
  });
  if (!h) return null;
  return deliverToHook(
    h,
    'ANNOUNCEMENT',
    `Test fire from ${process.env.SITE_NAME || 'lab2date'} admin`,
    `If you see this, the ${h.kind} integration works.`,
    '/admin/settings',
  );
}
