import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANONYMOUS_TRIGGERS,
  bareAddress,
  bypassesGuards,
  disposableDomainCount,
  disposableMatch,
  domainBlock,
  domainMatches,
  emailDomain,
  isAnonymousTrigger,
  isPermanentRecipientFailure,
  limitMessage,
  limitReached,
} from './rules';
import { defaultPolicy } from '../security/policy';

const policy = defaultPolicy();

test('the SMS gateways from the October 2026 abuse are blocked by default, subdomains too', () => {
  for (const d of ['txt.att.net', 'mms.att.net', 'vtext.com', 'vzwpix.com', 'tmomail.net', 'messaging.sprintpcs.com', 'sms.myboostmobile.com']) {
    const b = domainBlock(`5551234567@${d}`, policy);
    assert.equal(b?.kind, 'blocked', d);
    assert.match(b!.message, /can’t send e-mail/);
  }
  assert.equal(domainBlock('5551234567@MX.TXT.ATT.NET', policy)?.matched, 'txt.att.net');
  assert.equal(domainBlock('Someone <5551234567@txt.att.net>', policy)?.kind, 'blocked');
  // att.net itself (a real mailbox provider) is not on the list.
  assert.equal(domainBlock('jane@att.net', policy), null);
});

test('throw-away domains are refused unless allowed; real providers pass', () => {
  assert.ok(disposableDomainCount() > 5000);
  assert.equal(domainBlock('x@mailinator.com', policy)?.kind, 'disposable');
  assert.equal(disposableMatch('inbox.mailinator.com'), 'mailinator.com');
  assert.equal(domainBlock('x@mailinator.com', { ...policy, MAIL_ALLOWED_DOMAINS: ['mailinator.com'] }), null);
  assert.equal(domainBlock('x@mailinator.com', { ...policy, MAIL_BLOCK_DISPOSABLE: false }), null);
  // The admin's own block list wins over the allow list.
  assert.equal(domainBlock('x@vtext.com', { ...policy, MAIL_ALLOWED_DOMAINS: ['vtext.com'] })?.kind, 'blocked');
  for (const ok of ['jan@gmail.com', 'lab@uu.nl', 'p.jansen@labparts.nl', 'a@outlook.com', 'b@proton.me']) {
    assert.equal(domainBlock(ok, policy), null, ok);
  }
});

test('address helpers', () => {
  assert.equal(bareAddress('  Jane Doe <Jane@Example-Lab.NL> '), 'jane@example-lab.nl');
  assert.equal(emailDomain('jane@Example-Lab.NL.'), 'example-lab.nl');
  assert.equal(emailDomain('no-at-sign'), '');
  assert.equal(domainMatches('a.b.c', ['b.c']), 'b.c');
  assert.equal(domainMatches('xb.c', ['b.c']), null);
});

test('triggers: only what a visitor can cause without signing in is "anonymous"', () => {
  assert.ok(isAnonymousTrigger('auth.signup-code'));
  assert.ok(isAnonymousTrigger('auth.password-reset'));
  assert.ok(isAnonymousTrigger('form.support'));
  assert.ok(!isAnonymousTrigger('transactional'));
  assert.ok(!isAnonymousTrigger('account'));
  assert.ok(!isAnonymousTrigger(null));
  assert.ok(!isAnonymousTrigger('made-up'));
  assert.ok(ANONYMOUS_TRIGGERS.includes('auth.magic-link'));
  assert.ok(bypassesGuards('internal') && bypassesGuards('admin') && !bypassesGuards('transactional'));
});

test('limits: cooldown, daily cap, per-domain cap (big providers exempt), hourly total', () => {
  const zero = { cooldown: 0, day: 0, domain: 0, hour: 0 };
  assert.equal(limitReached(zero, policy, 'uu.nl'), null);
  assert.equal(limitReached({ ...zero, cooldown: 1 }, policy, 'uu.nl'), 'cooldown');
  assert.equal(limitReached({ ...zero, cooldown: 1 }, { ...policy, MAIL_ADDRESS_COOLDOWN_SEC: 0 }, 'uu.nl'), null);
  assert.equal(limitReached({ ...zero, day: policy.MAIL_ADDRESS_MAX_PER_DAY }, policy, 'uu.nl'), 'day');
  assert.equal(limitReached({ ...zero, day: policy.MAIL_ADDRESS_MAX_PER_DAY - 1 }, policy, 'uu.nl'), null);
  assert.equal(limitReached({ ...zero, domain: policy.MAIL_DOMAIN_MAX_PER_HOUR }, policy, 'uu.nl'), 'domain');
  assert.equal(limitReached({ ...zero, domain: policy.MAIL_DOMAIN_MAX_PER_HOUR }, policy, 'gmail.com'), null);
  assert.equal(limitReached({ ...zero, hour: policy.MAIL_ANON_MAX_PER_HOUR }, policy, 'gmail.com'), 'hour');
  assert.match(limitMessage('cooldown', 45), /in 45 seconds/);
  assert.match(limitMessage('cooldown', 600), /in 10 minutes/);
  assert.match(limitMessage('hour', 600), /unusual number/);
});

test('bounces: only a permanent rejection of the recipient counts, never a policy / login refusal', () => {
  // nodemailer, single recipient rejected at RCPT TO
  assert.ok(isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 <x@uu.nl>: Recipient address rejected: User unknown' }));
  assert.ok(isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 No such user here' }));
  assert.ok(isPermanentRecipientFailure({ responseCode: 554, command: 'DATA', response: '554 5.2.1 mailbox disabled' }));
  // temporary, or about us (relay / auth / content), or no code
  assert.ok(!isPermanentRecipientFailure({ responseCode: 450, command: 'RCPT TO', response: '450 4.2.0 mailbox busy' }));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 5.7.1 Relaying denied' }));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 535, command: 'AUTH PLAIN', response: '535 5.7.8 Authentication failed' }));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 552, command: 'DATA', response: '552 message size exceeds limit' }));
  assert.ok(!isPermanentRecipientFailure(new Error('Resend HTTP 422: invalid from')));
  assert.ok(!isPermanentRecipientFailure(null));
});
