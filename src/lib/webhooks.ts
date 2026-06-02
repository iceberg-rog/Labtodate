import { prisma } from '@/lib/db';

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

/** Dispatch an event to every active matching webhook. Fail-safe. */
export async function dispatchWebhook(
  kind: NotifyKind,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  let hooks: { id: string; kind: string; url: string; chatId: string | null; events: string[] }[] = [];
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
    hooks.map(async (h) => {
      const subscribed = h.events.includes('*') || h.events.includes(kind);
      if (!subscribed) return;
      const p = buildPayload(kind, title, body, href, h.kind, h.chatId);
      if (!p) return;
      try {
        const r = await fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': p.contentType },
          body: p.body,
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          await prisma.webhookConfig.update({
            where: { id: h.id },
            data: { lastError: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` },
          });
          return;
        }
        await prisma.webhookConfig.update({
          where: { id: h.id },
          data: { lastOkAt: new Date(), lastError: null },
        });
      } catch (e) {
        try {
          await prisma.webhookConfig.update({
            where: { id: h.id },
            data: { lastError: (e instanceof Error ? e.message : String(e)).slice(0, 200) },
          });
        } catch {/* nested swallow */}
      }
    }),
  );
}
