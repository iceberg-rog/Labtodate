/**
 * Structured (JSON) AI calls used by admin tools — separate from the
 * marketplace assistant in src/lib/ai.ts. Forces a strict JSON response so
 * the server can parse safely.
 */

import { ensureSettingsLoaded } from '@/lib/settings';
import { aiConfig } from '@/lib/ai';

/**
 * Anthropic-only: call Claude with the web_search tool enabled. The model
 * is allowed to do as many search calls as it wants and then must respond
 * with a JSON object containing the structured findings.
 *
 * Returns parsed JSON. Throws on shape errors. Silently falls back to a
 * plain aiJson() call if the provider isn't Anthropic or the API rejects
 * the web_search tool (older keys / regional availability).
 */
export async function aiJsonWithWebSearch<T = unknown>(opts: AiStructuredOptions & { maxSearches?: number }): Promise<T> {
  await ensureSettingsLoaded();
  const c = aiConfig();
  if (!c.key) throw new Error('AI provider not configured.');
  if (c.provider !== 'anthropic') return aiJson<T>(opts);

  const instr = `${opts.systemPrompt}\n\nIMPORTANT: After completing any web research, respond with ONLY a valid JSON object. No markdown fences, no commentary. The very first character must be { and the very last must be }.`;

  let raw: string;
  try {
    const res = await fetch(`${c.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: opts.maxTokens ?? 4000,
        system: instr,
        messages: [{ role: 'user', content: opts.userPrompt }],
        temperature: opts.temperature ?? 0.2,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: opts.maxSearches ?? 4 }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      // Server rejected the tool (e.g. wrong key tier). Retry without it.
      const errText = await res.text().catch(() => '');
      if (/web_search|tool/i.test(errText)) {
        console.warn('[ai-structured] web_search tool not available; falling back. Reason: ' + errText.slice(0, 160));
        return aiJson<T>(opts);
      }
      throw new Error(`AI provider ${res.status}: ${errText.slice(0, 240)}`);
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    // The model often emits several text + tool_use + tool_result blocks
    // before the final answer. Concatenate ALL text blocks; the JSON object
    // will be the last well-formed one.
    raw = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  } catch (e) {
    if (e instanceof Error && /web_search/i.test(e.message)) {
      return aiJson<T>(opts);
    }
    throw e;
  }
  // Strip optional markdown fence.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Take the LAST balanced JSON object — the model may have emitted other
  // braces during reasoning text.
  let depth = 0, end = -1, start = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') { if (end === -1) end = i; depth++; }
    else if (raw[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
  }
  if (start === -1 || end === -1) throw new Error(`AI returned no JSON: ${raw.slice(-240)}`);
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch (e) {
    throw new Error(`AI JSON parse failed: ${e instanceof Error ? e.message : 'unknown'}`);
  }
}

export interface AiStructuredOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Calls the configured AI provider with instructions to return JSON only.
 * Returns the parsed JSON. Throws if no key configured / network error / not
 * valid JSON.
 */
export async function aiJson<T = unknown>(opts: AiStructuredOptions): Promise<T> {
  await ensureSettingsLoaded();
  const c = aiConfig();
  if (!c.key) throw new Error('AI provider not configured (set AI_API_KEY in admin settings).');

  const instr = `${opts.systemPrompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. No markdown fences, no commentary. The very first character must be { and the very last must be }.`;

  let raw: string;
  if (c.provider === 'anthropic') {
    const res = await fetch(`${c.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: c.model,
        max_tokens: opts.maxTokens ?? 1500,
        system: instr,
        messages: [{ role: 'user', content: opts.userPrompt }],
        temperature: opts.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`AI provider ${res.status}: ${t.slice(0, 240)}`);
    }
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    raw = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
  } else {
    const res = await fetch(`${c.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({
        model: c.model,
        messages: [
          { role: 'system', content: instr },
          { role: 'user', content: opts.userPrompt },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1500,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`AI provider ${res.status}: ${t.slice(0, 240)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  }

  // Strip optional markdown fence the model may add despite instructions.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI returned non-JSON: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch (e) {
    throw new Error(`AI JSON parse failed: ${e instanceof Error ? e.message : 'unknown'} — got: ${raw.slice(0, 200)}`);
  }
}
