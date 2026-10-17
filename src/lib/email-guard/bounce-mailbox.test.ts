import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressToAct, describeImapError, imapConnection, looksLikeReport } from './bounce-mailbox';
import { defaultPolicy, planPolicySave } from '../security/policy';
import { settingDef } from '../settings/defs';

const policy = defaultPolicy();

test('bounce mailbox: off by default, every rule an admin setting, the password a secret', () => {
  assert.equal(policy.MAIL_BOUNCE_IMAP_ENABLED, false);
  assert.equal(policy.MAIL_BOUNCE_IMAP_PORT, 993);
  assert.equal(policy.MAIL_BOUNCE_IMAP_FOLDER, 'INBOX');
  assert.equal(policy.MAIL_BOUNCE_IMAP_MATCH_REQUIRED, true);
  for (const k of ['MAIL_BOUNCE_IMAP_ENABLED', 'MAIL_BOUNCE_IMAP_HOST', 'MAIL_BOUNCE_IMAP_PORT', 'MAIL_BOUNCE_IMAP_USER', 'MAIL_BOUNCE_IMAP_FOLDER',
    'MAIL_BOUNCE_IMAP_DONE_FOLDER', 'MAIL_BOUNCE_IMAP_MATCH_REQUIRED', 'MAIL_BOUNCE_IMAP_MAX_PER_RUN']) {
    assert.equal(settingDef(k)?.group, 'Security', k);
  }
  const pass = settingDef('MAIL_BOUNCE_IMAP_PASS');
  assert.equal(pass?.type, 'secret');
  assert.equal(pass?.secret, true);
});

/** The whole Security form with some fields changed (as abuse-policy.test.ts). */
function form(overrides: Record<string, string>) {
  const input: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(policy as unknown as Record<string, unknown>)) {
    if (typeof v === 'boolean') {
      if (v) input[k] = 'on';
    } else if (Array.isArray(v)) input[k] = k.startsWith('MAIL_') ? v.join('\n') : v;
    else input[k] = String(v);
  }
  return { ...input, ...overrides };
}

test('settings: switching on needs a server; the done folder must differ; bad names refused', () => {
  assert.match(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_ENABLED: 'on' })).problems.join(' '), /needs the IMAP server/);
  const ok = planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_ENABLED: 'on', MAIL_BOUNCE_IMAP_HOST: 'imap.transip.email', MAIL_BOUNCE_IMAP_DONE_FOLDER: 'Bounces' }));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.writes.map((w) => w.key).sort(), ['MAIL_BOUNCE_IMAP_DONE_FOLDER', 'MAIL_BOUNCE_IMAP_ENABLED', 'MAIL_BOUNCE_IMAP_HOST']);
  assert.match(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_DONE_FOLDER: 'inbox' })).problems.join(' '), /another folder/);
  assert.ok(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_HOST: 'imap.transip.email/x' })).problems.length);
  assert.ok(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_FOLDER: 'IN*BOX' })).problems.length);
  assert.ok(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_PORT: '0' })).problems.length);
  assert.deepEqual(planPolicySave(policy, form({ MAIL_BOUNCE_IMAP_FOLDER: 'INBOX/Mail Delivery' })).problems, []);
});

test('connection: always encrypted, login and password fall back to the SMTP ones', () => {
  const on = { ...policy, MAIL_BOUNCE_IMAP_HOST: 'imap.transip.email' };
  const smtp = { smtpUser: 'parts@labparts.nl', smtpPass: 'smtp-pass', imapPass: '' };
  const c = imapConnection(on, smtp);
  assert.ok(c.ok);
  assert.equal(c.options.secure, true);
  assert.equal(c.options.doSTARTTLS, undefined);
  assert.deepEqual(c.options.auth, { user: 'parts@labparts.nl', pass: 'smtp-pass' });
  assert.equal(c.mailbox, 'parts@labparts.nl@imap.transip.email:993/INBOX');

  const own = imapConnection({ ...on, MAIL_BOUNCE_IMAP_USER: 'bounces@labparts.nl' }, { ...smtp, imapPass: 'imap-pass' });
  assert.ok(own.ok);
  assert.deepEqual(own.options.auth, { user: 'bounces@labparts.nl', pass: 'imap-pass' });

  const starttls = imapConnection({ ...on, MAIL_BOUNCE_IMAP_PORT: 143 }, smtp);
  assert.ok(starttls.ok);
  assert.equal(starttls.options.secure, false);
  assert.equal(starttls.options.doSTARTTLS, true, 'a remote server on 143 must offer STARTTLS');
  const local = imapConnection({ ...on, MAIL_BOUNCE_IMAP_HOST: '127.0.0.1', MAIL_BOUNCE_IMAP_PORT: 3143 }, smtp);
  assert.ok(local.ok);
  assert.equal(local.options.doSTARTTLS, undefined);

  const missing = imapConnection({ ...policy }, { smtpUser: '', smtpPass: '', imapPass: '' });
  assert.ok(!missing.ok);
  assert.equal(missing.missing.length, 3);
});

test('only a report about an e-mail the site sent, to that address, is acted on', () => {
  const r = { finalRecipient: 'jan@uu.nl', originalRecipient: null };
  assert.equal(addressToAct(r, ['jan@uu.nl'], true), 'jan@uu.nl');
  assert.equal(addressToAct(r, ['piet@uu.nl'], true), null, 'Message-ID of ours but another address: a forged report');
  assert.equal(addressToAct(r, null, true), null, 'not about our e-mail');
  assert.equal(addressToAct(r, null, false), 'jan@uu.nl', 'switch off: any report counts');
  // Forwarded by the recipient's server: Original-Recipient is ours.
  assert.equal(addressToAct({ finalRecipient: 'jan@forward.example', originalRecipient: 'jan@uu.nl' }, ['jan@uu.nl'], true), 'jan@uu.nl');
});

test('which e-mails are opened: delivery reports only (not read receipts, not forwarded ones)', () => {
  assert.ok(looksLikeReport({ type: 'multipart/report', parameters: { 'report-type': 'delivery-status' } }));
  assert.ok(looksLikeReport({ type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'message/delivery-status' }] }));
  assert.ok(!looksLikeReport({ type: 'multipart/report', parameters: { 'report-type': 'disposition-notification' } }));
  assert.ok(!looksLikeReport({ type: 'multipart/mixed', childNodes: [{ type: 'message/rfc822', childNodes: [{ type: 'multipart/report', parameters: { 'report-type': 'delivery-status' } }] }] }));
  assert.ok(!looksLikeReport({ type: 'text/plain' }));
  assert.ok(!looksLikeReport(undefined));
});

test('connection problems are explained without the password', () => {
  assert.match(describeImapError({ authenticationFailed: true, responseText: 'Invalid credentials' }, 'imap.transip.email', 993), /refused the login/);
  assert.match(describeImapError({ code: 'ENOTFOUND' }, 'imap.transip.emial', 993), /imap\.transip\.emial was not found/);
  assert.match(describeImapError({ code: 'ECONNREFUSED' }, '127.0.0.1', 3143), /Nothing answered on 127\.0\.0\.1:3143/);
});
