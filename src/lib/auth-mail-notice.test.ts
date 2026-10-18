import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailCooldownNotice, noteMailRequest, secondsSinceMailRequest, waitText } from './auth-mail-notice';

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
  assert.match(s, /less than a minute ago\? Then no new e-mail was sent: check that e-mail, or try again in 60 s\./);
  assert.doesNotMatch(s, /account/);
  assert.match(mailCooldownNotice(60, null, 'code') ?? '', /a code in it still works\), or ask for a new code in 60 s/);
  // A request older than the wait counts as a first one.
  assert.equal(mailCooldownNotice(60, 75), mailCooldownNotice(60, null));
});

test('a second request inside the wait gets the time left', () => {
  const s = mailCooldownNotice(60, 12.4) ?? '';
  assert.match(s, /12 s ago/);
  assert.match(s, /at most one every minute, so no new e-mail was sent/);
  assert.match(s, /try again in 48 s\./);
  assert.match(mailCooldownNotice(90, 30, 'code') ?? '', /every 90 seconds.*the code from your first request still works, or ask for a new code in 60 s/);
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
