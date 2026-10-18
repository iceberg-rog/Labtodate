/**
 * AI provider configuration for the admin AI tools (Shops & suppliers:
 * supplier-shop suggestions and shop risk checks, and the import fallback
 * that reads a supplier product page) — see lib/ai-structured.ts. Settings →
 * AI assistant. The on-site chat that also used it was removed (support runs
 * on tickets), so nothing public calls an AI provider.
 *
 * These tools send supplier web pages and URLs, never customer data — which
 * is why the privacy policy names no AI provider. Keep it that way, or add
 * the provider to Settings → Site texts & pages → Privacy policy.
 *
 * Provider auto-detected from the API key prefix:
 *   - `sk-ant-*` → Anthropic (Claude). Uses /v1/messages.
 *   - anything else → OpenAI-compatible (/v1/chat/completions). Works with
 *     OpenAI, DeepSeek, Together, etc.
 *
 * Admin can override AI_BASE_URL + AI_MODEL via Settings to pin a specific
 * provider; the prefix sniff is just the default routing. Read after
 * `await ensureSettingsLoaded()`.
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
  };
}

export function aiConfigured(): boolean {
  return !!process.env.AI_API_KEY;
}
