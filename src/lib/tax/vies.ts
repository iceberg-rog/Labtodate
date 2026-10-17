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
 *    evidence with the real error, never served from cache, and the
 *    “When VIES is unavailable” policy (TAX_VIES_DOWN_POLICY) decides.
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

const g = globalThis as unknown as { __l2dVies?: ViesClient };
export function setViesClient(client: ViesClient | null): void {
  g.__l2dVies = client ?? undefined;
}
function client(): ViesClient {
  return g.__l2dVies ?? euViesClient;
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
  const p = parseVatId(raw);
  if (!p || !VIES_PREFIXES.includes(p.prefix)) {
    return {
      vatId: (raw || '').trim(), country: p?.country ?? '', status: 'INVALID', formatValid: false,
      source: 'FORMAT', validationId: null, error: 'Not an EU VAT ID (missing or unknown country prefix).',
    };
  }
  const formatValid = vatIdLooksValid(p.vatId);
  if (!formatValid) {
    return { vatId: p.vatId, country: p.country, status: 'INVALID', formatValid, source: 'FORMAT', validationId: null, error: `Does not match the ${p.prefix} VAT ID format.` };
  }
  const hours = settingInt('TAX_VIES_CACHE_HOURS', 24);
  // A check staff recorded BY HAND (VIES down for days, proof on file) is
  // evidence too — also while live checks are switched off.
  if (!opts.force) {
    const manual = await prisma.vatValidation.findFirst({
      where: { vatId: p.vatId, source: 'MANUAL', checkedAt: { gte: new Date(Date.now() - settingInt('TAX_MANUAL_VAT_CHECK_DAYS', 30) * 86_400_000) } },
      orderBy: { checkedAt: 'desc' },
    });
    if (manual && (manual.status === 'VALID' || manual.status === 'INVALID')) {
      return {
        vatId: p.vatId, country: p.country, status: manual.status as 'VALID' | 'INVALID', name: manual.name,
        consultationNumber: null, checkedAt: manual.checkedAt.toISOString(), formatValid, source: 'CACHE', validationId: manual.id,
        error: manual.status === 'VALID' ? 'Confirmed by hand by staff (evidence on file), not by a live VIES answer.' : null,
      };
    }
  }
  if (!settingBool('TAX_VIES_ENABLED')) {
    return { vatId: p.vatId, country: p.country, status: 'NOT_CHECKED', formatValid, source: 'DISABLED', validationId: null };
  }
  if (!opts.force) {
    const recent = await prisma.vatValidation.findMany({
      where: { vatId: p.vatId, status: { in: ['VALID', 'INVALID'] }, checkedAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
      orderBy: { checkedAt: 'desc' },
      take: 5,
    });
    // An INVALID row only counts when VIES really said valid=false (or staff
    // decided by hand) — never an error answer stored by older code.
    const cached = recent.find((r) => r.status === 'VALID' || r.source === 'MANUAL' || viesSaidInvalid(r.raw));
    if (cached) {
      return {
        vatId: p.vatId, country: p.country, status: cached.status as 'VALID' | 'INVALID', name: cached.name,
        consultationNumber: cached.consultationNumber, checkedAt: cached.checkedAt.toISOString(), formatValid,
        source: 'CACHE', validationId: cached.id,
      };
    }
  }
  // Our own VAT ID as requester → VIES returns a consultation number (evidence).
  const own = parseVatId(settingString('COMPANY_VAT'));
  let answer = await client().check(p.prefix, p.number, own ? { prefix: own.prefix, number: own.number } : null);
  if (answer.status === 'UNAVAILABLE' && answer.error === 'INVALID_REQUESTER_INFO' && own) {
    // VIES refused OUR VAT ID as requester (Settings → Company → VAT ID is not a
    // live VAT number). Still check the buyer — without a consultation number —
    // and keep the reason with the evidence so staff can fix the setting.
    const retry = await client().check(p.prefix, p.number, null);
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
