import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingBool, settingInt, settingString } from '@/lib/settings';
import { parseVatId, vatIdLooksValid, VIES_PREFIXES } from './vatid';
import type { VatIdEvidence } from './determine';

/**
 * VIES VAT-ID check — pluggable client + DB cache (VatValidation).
 *
 *  - `checkVatId()` returns a cached VALID/INVALID answer younger than
 *    TAX_VIES_CACHE_HOURS, else asks the client and stores the answer (every
 *    live answer is kept as evidence, incl. the VIES consultation number).
 *  - A VAT ID is only ever INVALID when VIES itself answered valid=false (or
 *    staff recorded it by hand). Any error — member state down, timeout, rate
 *    limit, our own VAT ID refused as requester — is UNAVAILABLE: stored as
 *    evidence with the real error, and the “When VIES is unavailable” policy
 *    (TAX_VIES_DOWN_POLICY) decides.
 *  - Transient VIES errors (concurrency limits, service unavailable, member
 *    state timeout) are retried twice with a short back-off before the answer
 *    counts as UNAVAILABLE.
 *  - After an UNAVAILABLE answer the same VAT ID is not asked again for
 *    TAX_VIES_RETRY_AFTER_MINUTES: that stored answer is returned (no new call,
 *    no new row) — a page that re-renders cannot hammer VIES during an outage.
 *  - `storedVatIdCheck()` never calls VIES (previews that re-render).
 *  - VIES refusing OUR VAT ID as requester (Settings → Company) alerts the
 *    admins (once a day): without it no consultation number is recorded.
 *  - TAX_VIES_ENABLED=false → no network call, status NOT_CHECKED.
 *  - Tests / other providers: `setViesClient(...)`.
 */

export interface ViesAnswer {
  status: 'VALID' | 'INVALID' | 'UNAVAILABLE';
  name?: string | null;
  address?: string | null;
  consultationNumber?: string | null;
  /** Provider error code when UNAVAILABLE (MS_UNAVAILABLE, TIMEOUT, …). */
  error?: string | null;
  raw?: unknown;
}

export interface ViesClient {
  check(prefix: string, number: string, requester?: { prefix: string; number: string } | null): Promise<ViesAnswer>;
}

const VIES_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

/** The EU's public VIES REST API. */
export const euViesClient: ViesClient = {
  async check(prefix, number, requester) {
    try {
      const res = await fetch(VIES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          countryCode: prefix,
          vatNumber: number,
          ...(requester ? { requesterMemberStateCode: requester.prefix, requesterNumber: requester.number } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !body) {
        return { status: 'UNAVAILABLE', error: `HTTP ${res.status}`, raw: body };
      }
      // VIES answers HTTP 200 with { actionSucceed: false, errorWrappers: [{ error }] }
      // when it could not check (member state down, bad requester, rate limit…).
      // That is NOT "invalid" — never store it as an invalid VAT ID.
      if (body.actionSucceed === false || Array.isArray(body.errorWrappers)) {
        const wrappers = Array.isArray(body.errorWrappers) ? (body.errorWrappers as Array<{ error?: unknown }>) : [];
        const code = typeof wrappers[0]?.error === 'string' ? (wrappers[0].error as string) : 'VIES_ERROR';
        return { status: 'UNAVAILABLE', error: code, raw: body };
      }
      if (typeof body.valid !== 'boolean') {
        return { status: 'UNAVAILABLE', error: 'unexpected VIES answer', raw: body };
      }
      const userError = typeof body.userError === 'string' ? body.userError : null;
      if (userError && userError !== 'VALID' && userError !== 'INVALID') {
        return { status: 'UNAVAILABLE', error: userError, raw: body };
      }
      const valid = body.valid === true;
      const clean = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '---' ? v.trim() : null);
      return {
        status: valid ? 'VALID' : 'INVALID',
        name: clean(body.name),
        address: clean(body.address),
        consultationNumber: clean(body.requestIdentifier),
        raw: body,
      };
    } catch (e) {
      return { status: 'UNAVAILABLE', error: e instanceof Error ? e.message.slice(0, 120) : 'network error' };
    }
  },
};

const g = globalThis as unknown as { __l2dVies?: ViesClient; __l2dViesRetryMs?: number[] };
export function setViesClient(client: ViesClient | null): void {
  g.__l2dVies = client ?? undefined;
}
function client(): ViesClient {
  return g.__l2dVies ?? euViesClient;
}

/** VIES error codes that usually clear within seconds: worth asking again. */
export const TRANSIENT_VIES_ERRORS: ReadonlySet<string> = new Set(['MS_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ', 'SERVICE_UNAVAILABLE', 'TIMEOUT']);
/** Waits before the 2nd and 3rd attempt. */
const RETRY_DELAYS_MS = [800, 2000];

/** Tests: shorter (or no) waits between retries; null restores the default. */
export function setViesRetryDelays(ms: number[] | null): void {
  g.__l2dViesRetryMs = ms ?? undefined;
}

/**
 * One VIES question with retries on transient errors (TRANSIENT_VIES_ERRORS):
 * at most 1 + delays.length attempts. Any other answer (valid, invalid, a
 * member state that is down) is final at once.
 */
export async function checkWithRetry(
  c: ViesClient,
  prefix: string,
  number: string,
  requester: { prefix: string; number: string } | null,
  delaysMs: number[] = g.__l2dViesRetryMs ?? RETRY_DELAYS_MS,
): Promise<ViesAnswer & { attempts: number }> {
  let attempts = 0;
  for (;;) {
    const answer = await c.check(prefix, number, requester);
    attempts++;
    const transient = answer.status === 'UNAVAILABLE' && !!answer.error && TRANSIENT_VIES_ERRORS.has(answer.error);
    if (!transient || attempts > delaysMs.length) return { ...answer, attempts };
    const wait = delaysMs[attempts - 1];
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/** The error code kept with a stored UNAVAILABLE answer (raw VIES body or { error }). */
export function storedViesError(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.error === 'string') return o.error;
  const w = Array.isArray(o.errorWrappers) ? (o.errorWrappers as Array<{ error?: unknown }>) : [];
  if (typeof w[0]?.error === 'string') return w[0].error as string;
  return typeof o.userError === 'string' ? o.userError : null;
}

type ValidationRow = { id: string; status: string; source: string; name: string | null; consultationNumber: string | null; checkedAt: Date; raw: unknown };

/**
 * The stored answers that count for a VAT ID, newest first: a check staff
 * recorded by hand (TAX_MANUAL_VAT_CHECK_DAYS), a real VALID/INVALID VIES
 * answer (TAX_VIES_CACHE_HOURS), and an UNAVAILABLE answer younger than
 * `unavailableMinutes` (0 = ignore those). Pure — the rows come from the DB.
 */
export function pickStoredAnswer(
  rows: ValidationRow[],
  now: number,
  w: { manualDays: number; cacheHours: number; unavailableMinutes: number },
): { row: ValidationRow; kind: 'MANUAL' | 'ANSWER' | 'UNAVAILABLE' } | null {
  const sorted = [...rows].sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime());
  const age = (r: ValidationRow) => now - r.checkedAt.getTime();
  const manual = sorted.find((r) => r.source === 'MANUAL' && (r.status === 'VALID' || r.status === 'INVALID') && age(r) <= w.manualDays * 86_400_000);
  if (manual) return { row: manual, kind: 'MANUAL' };
  // An INVALID row only counts when VIES really said valid=false — never an
  // error answer stored by older code.
  const answer = sorted.find((r) => r.source !== 'MANUAL' && age(r) <= w.cacheHours * 3_600_000 && (r.status === 'VALID' || (r.status === 'INVALID' && viesSaidInvalid(r.raw))));
  if (answer) return { row: answer, kind: 'ANSWER' };
  const fail = w.unavailableMinutes > 0 ? sorted.find((r) => r.source !== 'MANUAL' && r.status === 'UNAVAILABLE' && age(r) <= w.unavailableMinutes * 60_000) : undefined;
  return fail ? { row: fail, kind: 'UNAVAILABLE' } : null;
}

/** The rows pickStoredAnswer needs (three small indexed reads — never a VIES call). */
async function storedRows(vatId: string, w: { manualDays: number; cacheHours: number; unavailableMinutes: number }, now: number): Promise<ValidationRow[]> {
  const select = { id: true, status: true, source: true, name: true, consultationNumber: true, checkedAt: true, raw: true } as const;
  const [manual, answers, latest] = await Promise.all([
    prisma.vatValidation.findMany({ where: { vatId, source: 'MANUAL', checkedAt: { gte: new Date(now - w.manualDays * 86_400_000) } }, orderBy: { checkedAt: 'desc' }, take: 1, select }),
    prisma.vatValidation.findMany({ where: { vatId, status: { in: ['VALID', 'INVALID'] }, source: { not: 'MANUAL' }, checkedAt: { gte: new Date(now - w.cacheHours * 3_600_000) } }, orderBy: { checkedAt: 'desc' }, take: 5, select }),
    w.unavailableMinutes > 0
      ? prisma.vatValidation.findMany({ where: { vatId, status: 'UNAVAILABLE', source: { not: 'MANUAL' }, checkedAt: { gte: new Date(now - w.unavailableMinutes * 60_000) } }, orderBy: { checkedAt: 'desc' }, take: 1, select })
      : Promise.resolve([]),
  ]);
  return [...manual, ...answers, ...latest];
}

function resultFromStored(
  p: { vatId: string; country: string },
  formatValid: boolean,
  hit: NonNullable<ReturnType<typeof pickStoredAnswer>>,
): VatIdCheckResult {
  const { row, kind } = hit;
  const base = { vatId: p.vatId, country: p.country, formatValid, source: 'CACHE' as const, validationId: row.id, checkedAt: row.checkedAt.toISOString() };
  if (kind === 'MANUAL') {
    return {
      ...base, status: row.status as 'VALID' | 'INVALID', name: row.name, consultationNumber: null,
      error: row.status === 'VALID' ? 'Confirmed by hand by staff (evidence on file), not by a live VIES answer.' : null,
    };
  }
  if (kind === 'ANSWER') return { ...base, status: row.status as 'VALID' | 'INVALID', name: row.name, consultationNumber: row.consultationNumber };
  return { ...base, status: 'UNAVAILABLE', name: null, consultationNumber: null, error: storedViesError(row.raw) ?? 'VIES was unavailable' };
}

type ParsedForVies = { ok: true; p: { vatId: string; country: string; prefix: string; number: string }; formatValid: true } | { ok: false; result: VatIdCheckResult };

function parseForVies(raw: string): ParsedForVies {
  const p = parseVatId(raw);
  if (!p || !VIES_PREFIXES.includes(p.prefix)) {
    return {
      ok: false,
      result: { vatId: (raw || '').trim(), country: p?.country ?? '', status: 'INVALID', formatValid: false, source: 'FORMAT', validationId: null, error: 'Not an EU VAT ID (missing or unknown country prefix).' },
    };
  }
  if (!vatIdLooksValid(p.vatId)) {
    return { ok: false, result: { vatId: p.vatId, country: p.country, status: 'INVALID', formatValid: false, source: 'FORMAT', validationId: null, error: `Does not match the ${p.prefix} VAT ID format.` } };
  }
  return { ok: true, p, formatValid: true };
}

function storedWindows(viesEnabled: boolean) {
  return {
    manualDays: settingInt('TAX_MANUAL_VAT_CHECK_DAYS', 30),
    // With live checks off, only a check staff recorded by hand counts.
    cacheHours: viesEnabled ? settingInt('TAX_VIES_CACHE_HOURS', 24) : 0,
    unavailableMinutes: viesEnabled ? settingInt('TAX_VIES_RETRY_AFTER_MINUTES', 10) : 0,
  };
}

/**
 * What checkVatId would answer from stored evidence alone — NEVER a VIES call
 * and never a new row. For previews that re-render (the admin offer composer
 * refreshes every few seconds). Nothing stored → NOT_CHECKED (checked live
 * when the offer is really sent / accepted).
 */
export async function storedVatIdCheck(raw: string): Promise<VatIdCheckResult> {
  await ensureSettingsLoaded();
  const parsed = parseForVies(raw);
  if (!parsed.ok) return parsed.result;
  const { p, formatValid } = parsed;
  const enabled = settingBool('TAX_VIES_ENABLED');
  const now = Date.now();
  const w = storedWindows(enabled);
  const hit = pickStoredAnswer(await storedRows(p.vatId, w, now), now, w);
  if (hit) return resultFromStored(p, formatValid, hit);
  return {
    vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', formatValid, source: enabled ? 'CACHE' : 'DISABLED', validationId: null,
    error: enabled ? 'Not checked with VIES yet — it is checked live when the offer is sent or accepted.' : null,
  };
}

export interface VatIdCheckResult extends VatIdEvidence {
  /** CACHE = served from a previous VIES answer. */
  source: 'VIES' | 'CACHE' | 'DISABLED' | 'FORMAT';
  validationId: string | null;
  error?: string | null;
}

/** Check a buyer VAT ID (cached). Never throws. */
export async function checkVatId(raw: string, opts: { force?: boolean; actorId?: string | null } = {}): Promise<VatIdCheckResult> {
  await ensureSettingsLoaded();
  const parsed = parseForVies(raw);
  if (!parsed.ok) return parsed.result;
  const { p, formatValid } = parsed;
  const enabled = settingBool('TAX_VIES_ENABLED');
  // Stored evidence first: a check staff recorded BY HAND (VIES down for days,
  // proof on file — also while live checks are switched off), a recent real
  // VIES answer, or a VIES failure younger than TAX_VIES_RETRY_AFTER_MINUTES
  // (back-off: no new call, no new row). `force` (Settings → "Check now") always asks VIES.
  if (!opts.force) {
    const now = Date.now();
    const w = storedWindows(enabled);
    const hit = pickStoredAnswer(await storedRows(p.vatId, w, now), now, w);
    if (hit) return resultFromStored(p, formatValid, hit);
  }
  if (!enabled) {
    return { vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', formatValid, source: 'DISABLED', validationId: null };
  }
  // Our own VAT ID as requester → VIES returns a consultation number (evidence).
  const own = parseVatId(settingString('COMPANY_VAT'));
  let answer: ViesAnswer = await checkWithRetry(client(), p.prefix, p.number, own ? { prefix: own.prefix, number: own.number } : null);
  if (answer.status === 'UNAVAILABLE' && answer.error === 'INVALID_REQUESTER_INFO' && own) {
    // VIES refused OUR VAT ID as requester (Settings → Company → VAT ID is not a
    // live VAT number). Still check the buyer — without a consultation number —
    // and keep the reason with the evidence so staff can fix the setting.
    const retry = await checkWithRetry(client(), p.prefix, p.number, null);
    answer = { ...retry, error: retry.error ?? OWN_VAT_REJECTED };
    await alertOwnVatRejected(own.vatId);
  }
  let validationId: string | null = null;
  const checkedAt = new Date();
  try {
    const row = await prisma.vatValidation.create({
      data: {
        vatId: p.vatId, countryCode: p.country, status: answer.status, name: answer.name ?? null,
        address: answer.address ?? null, consultationNumber: answer.consultationNumber ?? null,
        source: 'VIES', checkedById: opts.actorId ?? null, checkedAt,
        raw: (answer.raw ?? (answer.error ? { error: answer.error } : undefined)) as object | undefined,
      },
      select: { id: true },
    });
    validationId = row.id;
  } catch {
    /* evidence row is best-effort; the answer still counts */
  }
  return {
    vatId: p.vatId, country: p.country, status: answer.status, name: answer.name ?? null,
    consultationNumber: answer.consultationNumber ?? null, checkedAt: checkedAt.toISOString(), formatValid,
    source: 'VIES', validationId, error: answer.error ?? null,
  };
}

export const OWN_VAT_REJECTED = 'Our own VAT ID (Settings → Company) was rejected by VIES as requester — no consultation number was recorded.';

/** VIES answered valid=false (the only real "invalid"). */
export function viesSaidInvalid(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).valid === false && (raw as Record<string, unknown>).actionSucceed !== false;
}

const OWN_VAT_ALERT = 'VIES rejects our own VAT ID';
/** Tell the admins (at most once a day) that Settings → Company → VAT ID is not accepted by VIES. */
async function alertOwnVatRejected(ownVatId: string): Promise<void> {
  try {
    const recent = await prisma.notification.findFirst({ where: { title: OWN_VAT_ALERT, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } }, select: { id: true } });
    if (recent) return;
    // Dynamic: observability pulls in the request/session helpers, which pure
    // scripts and tests that only check VAT IDs do not need.
    const { notifyAdmins } = await import('@/lib/observability');
    await notifyAdmins(
      OWN_VAT_ALERT,
      `VIES answered INVALID_REQUESTER_INFO for ${ownVatId} (Settings → Company → VAT ID). Buyer VAT IDs are still checked, but no VIES consultation number (your evidence for 0% intra-EU invoices) is recorded until our own VAT ID is a live, VIES-registered number.`,
      '/admin/settings?tab=Company',
      'SYSTEM',
    );
  } catch {
    /* alerting is best-effort; the check result already carries the reason */
  }
}

/** Staff confirm a VAT ID by hand (VIES down for days, documents on file). */
export async function recordManualVatValidation(raw: string, status: 'VALID' | 'INVALID', actorId: string, note?: string): Promise<string | null> {
  const p = parseVatId(raw);
  if (!p) return null;
  const row = await prisma.vatValidation.create({
    data: { vatId: p.vatId, countryCode: p.country, status, source: 'MANUAL', checkedById: actorId, raw: note ? { note } : undefined },
    select: { id: true },
  });
  return row.id;
}
