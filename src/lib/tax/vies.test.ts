import { test } from 'node:test';
import assert from 'node:assert/strict';
import { euViesClient, viesSaidInvalid } from './vies';

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
