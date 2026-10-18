import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldBackNotice, mailCooldownNotice, noteMailRequest, secondsSinceMailRequest, waitText } from './auth-mail-notice';

test('waitText words the per-address wait', () => {
  assert.equal(waitText(60), 'a minute');
  assert.equal(waitText(45), '45 seconds');
  assert.equal(waitText(90), '90 seconds');
  assert.equal(waitText(300), '5 minutes');
  assert.equal(waitText(3600), 'an hour');
  assert.equal(waitText(7200), '2 hours');
});

test('no wait configured: no cooldown sentence', () => {
  assert.equal(mailCooldownNotice(0, null), null);
  assert.equal(mailCooldownNotice(0, 5), null);
});

test('first request: the true, enumeration-safe sentence with the wait', () => {
  const s = mailCooldownNotice(60, null) ?? '';
  // "no new link": a sign-in notice (no account …) is not held back, so an
  // e-mail may still have gone out.
  assert.match(s, /less than a minute ago\? Then no new link was sent: check that e-mail, or try again in 60 s\./);
  assert.doesNotMatch(s, /account|no new e-mail/);
  assert.match(mailCooldownNotice(60, null, 'code') ?? '', /a code in it still works\), or ask for a new code in 60 s/);
  // A request older than the wait counts as a first one.
  assert.equal(mailCooldownNotice(60, 75), mailCooldownNotice(60, null));
});

test('a second request inside the wait gets the time left', () => {
  const s = mailCooldownNotice(60, 12.4) ?? '';
  assert.match(s, /12 s ago/);
  assert.match(s, /at most one sign-in link, code or reset link every minute, so no new link was sent: check that e-mail/);
  assert.match(s, /try again in 48 s\./);
  assert.match(mailCooldownNotice(90, 30, 'code') ?? '', /every 90 seconds, so no new code was sent: use that e-mail \(a code in it still works\), or ask for a new code in 60 s/);
});

test('heldBackNotice: only for a request inside the wait (the resend button keeps its own text otherwise)', () => {
  assert.equal(heldBackNotice(60, null, 'code'), null);
  assert.equal(heldBackNotice(60, 60, 'code'), null);
  assert.equal(heldBackNotice(0, 5, 'code'), null);
  assert.equal(heldBackNotice(60, 20, 'code'), mailCooldownNotice(60, 20, 'code'));
  assert.match(heldBackNotice(60, 20, 'code') ?? '', /20 s ago.*no new code was sent.*ask for a new code in 40 s\./);
});

test('noteMailRequest remembers per address and does not restart the wait inside it', () => {
  const t0 = 1_000_000;
  assert.equal(noteMailRequest('A@Lab.example', 60, t0), null);
  assert.equal(secondsSinceMailRequest(' a@lab.example ', t0 + 10_000), 10);
  // Inside the wait: reports 20 s and keeps the first time (the guard sent nothing new).
  assert.equal(noteMailRequest('a@lab.example', 60, t0 + 20_000), 20);
  assert.equal(secondsSinceMailRequest('a@lab.example', t0 + 30_000), 30);
  // After the wait: a fresh request restarts it.
  assert.equal(noteMailRequest('a@lab.example', 60, t0 + 70_000), 70);
  assert.equal(secondsSinceMailRequest('a@lab.example', t0 + 75_000), 5);
  assert.equal(secondsSinceMailRequest('other@lab.example', t0), null);
});
