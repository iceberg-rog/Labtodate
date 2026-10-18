import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardOutgoing, mailKeys, type MailCounterStore } from './index';
import { defaultPolicy } from '../security/policy';

// No suppression lookup and no alert mail: the test touches no database.
const policy = { ...defaultPolicy(), MAIL_BOUNCE_SUPPRESS_AFTER: 0, MAIL_GUARD_ALERTS: false };

/** rate_limit_bucket in memory: fixed windows from the first hit. */
function memoryCounters(): MailCounterStore & { counts: Map<string, number> } {
  const rows = new Map<string, { count: number; resetAt: Date }>();
  const counts = new Map<string, number>();
  const live = (key: string) => {
    const r = rows.get(key);
    return r && r.resetAt > new Date() ? r : undefined;
  };
  return {
    counts,
    async peek(key) {
      const r = live(key);
      return r ? { count: r.count, resetAt: r.resetAt } : { count: 0, resetAt: null };
    },
    async hit(key, windowMs) {
      const r = live(key) ?? { count: 0, resetAt: new Date(Date.now() + windowMs) };
      r.count += 1;
      rows.set(key, r);
      counts.set(key, r.count);
      return { count: r.count, resetAt: r.resetAt };
    },
  };
}

test('an ordinary visitor e-mail starts the per-address wait', async () => {
  const counters = memoryCounters();
  assert.equal((await guardOutgoing('jan@lab.example', 'auth.magic-link', policy, { counters })).ok, true);
  const second = await guardOutgoing('jan@lab.example', 'auth.password-reset', policy, { counters });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.code, 'EMAIL_COOLDOWN');
});

test('skipCooldown: a sign-in notice neither waits nor starts the wait, so the reset link it points to goes out', async () => {
  const counters = memoryCounters();
  const addr = 'piet@lab.example';
  // Sent inside a wait another e-mail started …
  assert.equal((await guardOutgoing(addr, 'auth.magic-link', policy, { counters })).ok, true);
  assert.equal((await guardOutgoing(addr, 'auth.notice', policy, { counters, skipCooldown: true })).ok, true);
  // … and starts none: the reset link right after it is only held by the earlier link's wait.
  const fresh = memoryCounters();
  assert.equal((await guardOutgoing(addr, 'auth.notice', policy, { counters: fresh, skipCooldown: true })).ok, true);
  assert.equal(fresh.counts.get(mailKeys.cooldown(addr)), undefined);
  assert.equal((await guardOutgoing(addr, 'auth.password-reset', policy, { counters: fresh })).ok, true);
});

test('skipCooldown notices still count toward the daily, per-domain and hourly caps', async () => {
  const counters = memoryCounters();
  const addr = 'kees@lab.example';
  for (let i = 0; i < policy.MAIL_ADDRESS_MAX_PER_DAY; i++) {
    assert.equal((await guardOutgoing(addr, 'auth.notice', policy, { counters, skipCooldown: true })).ok, true, `notice ${i + 1}`);
  }
  assert.equal(counters.counts.get(mailKeys.day(addr)), policy.MAIL_ADDRESS_MAX_PER_DAY);
  assert.equal(counters.counts.get(mailKeys.domain('lab.example')), policy.MAIL_ADDRESS_MAX_PER_DAY);
  assert.equal(counters.counts.get(mailKeys.hour()), policy.MAIL_ADDRESS_MAX_PER_DAY);
  const over = await guardOutgoing(addr, 'auth.notice', policy, { counters, skipCooldown: true });
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.reason, 'per-address daily cap');

  // The site-wide hourly total (rotating addresses and IPs) stops notices too.
  const small = { ...policy, MAIL_ANON_MAX_PER_HOUR: 3 };
  const site = memoryCounters();
  for (let i = 0; i < 3; i++) assert.equal((await guardOutgoing(`u${i}@gmail.com`, 'auth.notice', small, { counters: site, skipCooldown: true })).ok, true);
  const capped = await guardOutgoing('u9@gmail.com', 'auth.notice', small, { counters: site, skipCooldown: true });
  assert.equal(capped.ok, false);
  assert.equal(!capped.ok && capped.scope, 'site');
});
