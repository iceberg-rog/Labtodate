import { parseVatId } from './vatid';
import type { ViesEvidence } from './vat';

/**
 * Live VAT-ID check against the EU's VIES REST service. Never throws: any
 * network or service problem comes back as status UNAVAILABLE with the reason,
 * and the VAT rules decide what that means (Admin → Documents → VAT).
 * Definite answers (valid / invalid) are cached for an hour per VAT ID.
 */

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';
const TIMEOUT_MS = 8_000;
const CACHE_MS = 60 * 60_000;

type Hit = { at: number; value: ViesEvidence };
const g = globalThis as unknown as { __viesCache?: Map<string, Hit> };
const cache: Map<string, Hit> = (g.__viesCache ??= new Map());

/** Tests replace the network call. */
let fetcher: typeof fetch = (...args) => fetch(...args);
export function setViesFetcher(f: typeof fetch | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
  cache.clear();
}

export async function checkVies(raw: string, opts: { force?: boolean } = {}): Promise<ViesEvidence> {
  const parsed = parseVatId(raw);
  const now = new Date().toISOString();
  if (!parsed) return { vatId: (raw || '').trim().toUpperCase(), status: 'INVALID', checkedAt: now, error: 'Not a VAT ID (it must start with a two-letter country code, e.g. DE123456789).' };
  const hit = cache.get(parsed.vatId);
  if (!opts.force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetcher(VIES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ countryCode: parsed.prefix, vatNumber: parsed.number }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      valid?: boolean;
      name?: string;
      address?: string;
      userError?: string;
      errorWrappers?: { error?: string }[];
    };
    const serviceError = body.userError && body.userError !== 'VALID' && body.userError !== 'INVALID' ? body.userError : body.errorWrappers?.[0]?.error;
    if (!res.ok || (serviceError && typeof body.valid !== 'boolean')) {
      return { vatId: parsed.vatId, status: 'UNAVAILABLE', checkedAt: now, error: serviceError || `HTTP ${res.status}` };
    }
    if (typeof body.valid !== 'boolean') {
      return { vatId: parsed.vatId, status: 'UNAVAILABLE', checkedAt: now, error: 'Unexpected answer from VIES' };
    }
    const clean = (v?: string) => (v && v.trim() && v.trim() !== '---' ? v.trim().replace(/\s+\n/g, '\n') : null);
    const value: ViesEvidence = {
      vatId: parsed.vatId,
      status: body.valid ? 'VALID' : 'INVALID',
      name: clean(body.name),
      address: clean(body.address),
      checkedAt: now,
    };
    cache.set(parsed.vatId, { at: Date.now(), value });
    return value;
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? `no answer within ${TIMEOUT_MS / 1000}s` : e.message) : String(e);
    return { vatId: parsed.vatId, status: 'UNAVAILABLE', checkedAt: now, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
