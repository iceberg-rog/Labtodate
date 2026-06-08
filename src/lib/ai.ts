import { ensureSettingsLoaded } from '@/lib/settings';

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Provider auto-detected from the API key prefix:
 *   - `sk-ant-*` → Anthropic (Claude). Uses /v1/messages.
 *   - anything else → OpenAI-compatible (/v1/chat/completions). Works with
 *     OpenAI, DeepSeek, Together, etc.
 *
 * Admin can override AI_BASE_URL + AI_MODEL via Settings to pin a specific
 * provider; the prefix sniff is just the default routing.
 */
function detectProvider(key: string): 'anthropic' | 'openai-compatible' {
  return key.startsWith('sk-ant-') ? 'anthropic' : 'openai-compatible';
}

export function aiConfig() {
  const key = process.env.AI_API_KEY || '';
  const provider = detectProvider(key);
  const baseDefault = provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  const modelDefault = provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
  return {
    key,
    provider,
    base: (process.env.AI_BASE_URL || baseDefault).replace(/\/+$/, ''),
    model: process.env.AI_MODEL || modelDefault,
    name: process.env.ASSISTANT_NAME || 'lab2date Assistant',
  };
}

export function aiConfigured(): boolean {
  return !!process.env.AI_API_KEY;
}

const SYSTEM = `You are the on-site assistant for lab2date, a B2B marketplace for refurbished and surplus laboratory & analytical equipment (HPLC, GC, mass spec, spectroscopy, centrifuges, parts).
Be concise, professional and helpful. You can explain: how to request a quote (/let-us-find-it), buy now or add to cart, the proforma/invoice flow,  worldwide crated+insured shipping, how to sell equipment to lab2date (/sell), order tracking (/app/orders), returns/refunds, and support (/support).
Never reveal internal suppliers or that listings are sourced from third-party shops — lab2date is the single counterparty. If unsure or for account-specific issues, advise opening a support ticket at /support. Keep answers under ~120 words unless asked for detail.`;

/**
 * Call the LLM. Returns assistant text. Auto-routes between Anthropic and
 * OpenAI-compatible based on the configured key.
 */
export async function aiChat(history: AIMessage[]): Promise<string> {
  await ensureSettingsLoaded();
  const c = aiConfig();
  if (!c.key) {
    return "The assistant isn't configured yet. Please email support or open a ticket at /support and we'll help right away.";
  }

  // ── Anthropic Claude branch ──
  if (c.provider === 'anthropic') {
    const messages = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-12);
    // Anthropic requires the first message to be 'user'. If the trimmed
    // history starts with 'assistant', drop until we hit a 'user'.
    while (messages.length > 0 && messages[0].role !== 'user') messages.shift();
    if (messages.length === 0) return 'How can I help?';
    const res = await fetch(`${c.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: 500,
        system: SYSTEM,
        messages,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`AI provider error ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || 'Sorry, I could not generate a reply.';
  }

  // ── OpenAI-compatible branch ──
  const res = await fetch(`${c.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${c.key}`,
    },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: SYSTEM }, ...history].slice(-12),
      temperature: 0.3,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI provider error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content?.trim() || 'Sorry, I could not generate a reply.';
}
