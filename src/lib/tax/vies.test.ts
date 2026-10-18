import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWithRetry, euViesClient, pickStoredAnswer, storedViesError, viesSaidInvalid, type ViesAnswer, type ViesClient } from './vies';

/** Run the real VIES client against a canned HTTP answer. */
async function answer(status: number, body: unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  try {
    return await euViesClient.check('IE', '6388047V', { prefix: 'NL', number: '123456789B01' });
  } finally {
    globalThis.fetch = real;
  }
}

test('VIES errors are UNAVAILABLE with the real error code, never INVALID', async () => {
  for (const code of ['INVALID_REQUESTER_INFO', 'MS_UNAVAILABLE', 'MS_MAX_CONCURRENT_REQ', 'TIMEOUT', 'SERVICE_UNAVAILABLE']) {
    const r = await answer(200, { actionSucceed: false, errorWrappers: [{ error: code }] });
    assert.equal(r.status, 'UNAVAILABLE', code);
    assert.equal(r.error, code);
  }
  const http = await answer(500, { message: 'boom' });
  assert.equal(http.status, 'UNAVAILABLE');
  assert.match(http.error ?? '', /HTTP 500/);
  const user = await answer(200, { valid: false, userError: 'MS_UNAVAILABLE' });
  assert.equal(user.status, 'UNAVAILABLE');
  const odd = await answer(200, { hello: 'world' });
  assert.equal(odd.status, 'UNAVAILABLE');
});

test('only valid=false from VIES is INVALID; valid=true is VALID with the evidence', async () => {
  const bad = await answer(200, { valid: false, name: '---', address: '---' });
  assert.equal(bad.status, 'INVALID');
  const good = await answer(200, { valid: true, name: 'GOOGLE IRELAND LIMITED', address: 'DUBLIN', requestIdentifier: 'WAPIAAAAX' });
  assert.equal(good.status, 'VALID');
  assert.equal(good.name, 'GOOGLE IRELAND LIMITED');
  assert.equal(good.consultationNumber, 'WAPIAAAAX');
});

test('cache: an INVALID row counts only when VIES said valid=false', () => {
  assert.equal(viesSaidInvalid({ valid: false, name: '---' }), true);
  assert.equal(viesSaidInvalid({ actionSucceed: false, errorWrappers: [{ error: 'INVALID_REQUESTER_INFO' }] }), false);
  assert.equal(viesSaidInvalid(null), false);
  assert.equal(viesSaidInvalid({ error: 'MS_UNAVAILABLE' }), false);
});

/** A client that plays back a script of answers and counts the calls. */
function scripted(...answers: ViesAnswer[]): ViesClient & { calls: number } {
  const c = {
    calls: 0,
    async check() {
      const a = answers[Math.min(c.calls, answers.length - 1)];
      c.calls++;
      return a;
    },
  };
  return c;
}
const busy: ViesAnswer = { status: 'UNAVAILABLE', error: 'MS_MAX_CONCURRENT_REQ' };

test('transient VIES errors are retried twice, then the answer counts', async () => {
  const ok = scripted(busy, { status: 'UNAVAILABLE', error: 'GLOBAL_MAX_CONCURRENT_REQ' }, { status: 'VALID', name: 'ACME BV' });
  const r = await checkWithRetry(ok, 'BE', '0417497106', null, [0, 0]);
  assert.equal(r.status, 'VALID');
  assert.equal(r.attempts, 3);
  assert.equal(ok.calls, 3);

  for (const code of ['MS_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ', 'SERVICE_UNAVAILABLE', 'TIMEOUT']) {
    const down = scripted({ status: 'UNAVAILABLE', error: code });
    const d = await checkWithRetry(down, 'BE', '0417497106', null, [0, 0]);
    assert.equal(d.status, 'UNAVAILABLE', code);
    assert.equal(down.calls, 3, `${code}: 1 try + 2 retries`);
  }
});

test('non-transient answers are final at once (no retry)', async () => {
  for (const a of [{ status: 'UNAVAILABLE', error: 'MS_UNAVAILABLE' }, { status: 'INVALID' }, { status: 'VALID' }] as ViesAnswer[]) {
    const c = scripted(a);
    await checkWithRetry(c, 'DE', '123456789', null, [0, 0]);
    assert.equal(c.calls, 1, `${a.status} ${a.error ?? ''}`);
  }
});

const W = { manualDays: 30, cacheHours: 24, unavailableMinutes: 10 };
const NOW = Date.parse('2026-10-18T12:00:00Z');
const row = (o: { status: string; source?: string; minutesAgo: number; raw?: unknown }) => ({
  id: `${o.status}-${o.minutesAgo}`, status: o.status, source: o.source ?? 'VIES', name: null, consultationNumber: null,
  checkedAt: new Date(NOW - o.minutesAgo * 60_000), raw: o.raw ?? null,
});

test('back-off: an UNAVAILABLE answer younger than the window is re-used (no new call)', () => {
  const hit = pickStoredAnswer([row({ status: 'UNAVAILABLE', minutesAgo: 3, raw: { error: 'MS_UNAVAILABLE' } })], NOW, W);
  assert.equal(hit?.kind, 'UNAVAILABLE');
  assert.equal(pickStoredAnswer([row({ status: 'UNAVAILABLE', minutesAgo: 11 })], NOW, W), null, 'older → ask VIES again');
  assert.equal(pickStoredAnswer([row({ status: 'UNAVAILABLE', minutesAgo: 3 })], NOW, { ...W, unavailableMinutes: 0 }), null);
});

test('stored answers: a hand check first, then a real VIES answer, never an old error row as INVALID', () => {
  const valid = row({ status: 'VALID', minutesAgo: 120 });
  const fail = row({ status: 'UNAVAILABLE', minutesAgo: 2 });
  assert.equal(pickStoredAnswer([fail, valid], NOW, W)?.row.id, valid.id, 'a confirmed VAT ID stays confirmed during an outage');
  const manual = row({ status: 'VALID', source: 'MANUAL', minutesAgo: 60 * 24 * 10 });
  assert.equal(pickStoredAnswer([valid, manual], NOW, W)?.kind, 'MANUAL');
  const legacyInvalid = row({ status: 'INVALID', minutesAgo: 5, raw: { actionSucceed: false, errorWrappers: [{ error: 'MS_UNAVAILABLE' }] } });
  assert.equal(pickStoredAnswer([legacyInvalid], NOW, W), null);
  const realInvalid = row({ status: 'INVALID', minutesAgo: 5, raw: { valid: false } });
  assert.equal(pickStoredAnswer([realInvalid], NOW, W)?.kind, 'ANSWER');
  assert.equal(pickStoredAnswer([row({ status: 'VALID', minutesAgo: 60 * 25 })], NOW, W), null, 'past TAX_VIES_CACHE_HOURS');
});

test('the error code of a stored failure is read back', () => {
  assert.equal(storedViesError({ error: 'TIMEOUT' }), 'TIMEOUT');
  assert.equal(storedViesError({ actionSucceed: false, errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }] }), 'MS_MAX_CONCURRENT_REQ');
  assert.equal(storedViesError({ valid: false, userError: 'MS_UNAVAILABLE' }), 'MS_UNAVAILABLE');
  assert.equal(storedViesError(null), null);
});
