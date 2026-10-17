import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyDsnRecipient, parseDsn, parseFieldGroups } from './dsn';
import { isAddressStatus, isPermanentRecipientFailure } from './rules';

// Real bounce reports (see __fixtures__/dsn/README.md).
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'dsn', name));
const parse = async (name: string) => {
  const d = await parseDsn(fixture(name));
  assert.ok(d, `${name} is a delivery status report`);
  return d;
};

test('TransIP (Postfix) report about a verification code Gmail refused: address, 5.1.1, and the Message-ID of our e-mail', async () => {
  const d = await parse('transip-postfix-gmail-5.1.1.eml');
  assert.equal(d.reportFrom, 'mailer-daemon@smtp.transip.email');
  assert.equal(d.reportingMta, 'smtp.transip.email');
  assert.equal(d.originalMessageId, '8c2f7d1e-5b40-4f0e-9a6c-3e1d2b7a9f04@labparts.nl');
  assert.equal(d.originalSubject, '48213 is your lab2date verification code');
  assert.equal(d.recipients.length, 1);
  const [r] = d.recipients;
  assert.equal(r.finalRecipient, 'lab.manager.typo4471@gmail.com');
  assert.equal(r.status, '5.1.1');
  assert.equal(r.action, 'failed');
  assert.equal(r.remoteMta, 'gmail-smtp-in.l.google.com');
  assert.match(r.diagnostic!, /^550-5\.1\.1 The email account that you tried to reach does not exist\. Please try 550-5\.1\.1 double-checking/);
  assert.equal(r.verdict, 'permanent');
});

test('real reports that mean "this address does not exist" count', async () => {
  const gmail = await parse('sisimai-lhost-postfix-31.eml'); // Postfix relay, Gmail 550-5.1.1
  assert.deepEqual(gmail.recipients.map((r) => [r.finalRecipient, r.status, r.verdict]), [['kijitora@gmail.com', '5.1.1', 'permanent']]);
  assert.equal(gmail.originalMessageId, 'ffffff-eeeeee-22@neko.example.com');

  const noDomain = await parse('sisimai-lhost-postfix-06.eml'); // Postfix: Host or domain name not found
  assert.deepEqual(noDomain.recipients.map((r) => [r.status, r.verdict]), [['5.4.4', 'permanent']]);

  const m365 = await parse('sisimai-lhost-office365-13.eml'); // Microsoft 365: RecipientNotFound
  assert.deepEqual(m365.recipients.map((r) => [r.finalRecipient, r.status, r.verdict]), [['kijitora-nyaan@neko.kyoto.example.jp', '5.1.10', 'permanent']]);
  assert.equal(m365.originalMessageId, null, 'this one returns the headers without a Message-ID');
  assert.equal(m365.originalSubject, 'にゃーん', 'encoded subjects are decoded');
});

test('one report, several recipients: each one judged on its own', async () => {
  const d = await parse('sisimai-lhost-outlook-04.eml');
  assert.deepEqual(
    d.recipients.map((r) => [r.finalRecipient, r.status, r.verdict]),
    [
      ['sabineko@example.co.jp', '5.1.1', 'permanent'],
      ['mikeneko@example.co.jp', '5.2.2', 'other'], // mailbox full
    ],
  );
});

test('Original-Recipient (the address we sent to) is kept when the server rewrote it', async () => {
  const d = await parse('sisimai-lhost-postfix-01.eml');
  assert.equal(d.recipients[0].finalRecipient, 'r@p351355.pool.example.ne.jp');
  assert.equal(d.recipients[0].originalRecipient, 'kijitora@example.org');
});

test('reports that say nothing about the address never count', async () => {
  const cases: [string, string, string][] = [
    ['sisimai-lhost-postfix-63.eml', '5.2.2', 'other'], // quota exceeded
    ['sisimai-lhost-postfix-70.eml', '5.7.26', 'policy'], // Gmail: unauthenticated (DMARC)
    ['sisimai-lhost-postfix-10.eml', '5.1.8', 'other'], // the SENDER's domain was refused
    ['sisimai-lhost-postfix-59.eml', '5.2.1', 'other'], // Gmail: user receiving mail too fast
    ['sisimai-rfc3464-07.eml', '4.4.0', 'temporary'], // delayed, still trying
  ];
  for (const [name, status, verdict] of cases) {
    const d = await parse(name);
    assert.ok(d.recipients.length >= 1, name);
    for (const r of d.recipients) {
      assert.equal(r.status, status, name);
      assert.equal(r.verdict, verdict, name);
    }
  }
});

test('not a delivery status report: an old plain-text bounce, a person’s e-mail', async () => {
  assert.equal(await parseDsn(fixture('sisimai-lhost-gmail-01.eml')), null);
  const personal = 'From: Jan <jan@uu.nl>\r\nTo: parts@labparts.nl\r\nSubject: Re: quote 1042\r\nMessage-ID: <a@uu.nl>\r\n\r\nThanks, the 5.1.1 part number is fine.\r\n';
  assert.equal(await parseDsn(personal), null);
});

test('classify: only failures about the address itself count', () => {
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.1.1', diagnostic: 'smtp; 550 5.1.1 <a@b.nl>: Recipient address rejected: User unknown' }), 'permanent');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.0.0', diagnostic: '550 5.1.1 user unknown' }), 'permanent', 'generic 5.0.0 wrapping a 5.1.1');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.0.0', diagnostic: '550 No such user here' }), 'permanent', 'no code, clear wording');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: null, diagnostic: 'smtp; 550 User not found' }), 'permanent');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.2.1', diagnostic: '550-5.2.1 The email account that you tried to reach is disabled.' }), 'permanent');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.0.0', diagnostic: '554 5.7.1 Service unavailable; Client host blocked using zen.spamhaus.org' }), 'policy');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.1.1', diagnostic: '550 5.7.1 Recipient address rejected: Access denied' }), 'policy', '5.7.x anywhere wins');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.1.0', diagnostic: '550 5.1.0 192.0.2.1 is not allowed to send from <labparts.nl> per its SPF Record' }), 'other');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.3.4', diagnostic: '552 5.3.4 Message size exceeds fixed limit' }), 'other');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.0.0', diagnostic: '552 Mailbox is full, user unknown quota' }), 'other');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '4.4.7', diagnostic: '550 4.4.7 QUEUE.Expired; message expired' }), 'temporary');
  assert.equal(classifyDsnRecipient({ action: 'delayed', status: '5.1.1', diagnostic: null }), 'temporary', 'delayed = still trying');
  assert.equal(classifyDsnRecipient({ action: 'delivered', status: '2.0.0', diagnostic: '250 OK' }), 'delivered');
  assert.equal(classifyDsnRecipient({ action: 'failed', status: '5.0.0', diagnostic: '554 Transaction failed' }), 'other');
});

test('delivery-status fields: groups, folded lines, address types, first field wins', () => {
  const groups = parseFieldGroups(
    'Reporting-MTA: dns; mx.example\r\nArrival-Date: Sat, 17 Oct 2026\r\n\r\nFinal-Recipient: rfc822; A@B.NL\r\nStatus: 5.1.1\r\nStatus: 4.0.0\r\nDiagnostic-Code: smtp; 550 5.1.1\r\n    user unknown\r\n\r\n\r\nFinal-Recipient: c@d.nl\r\nAction: failed\r\n',
  );
  assert.equal(groups.length, 3);
  assert.equal(groups[0]['reporting-mta'], 'dns; mx.example');
  assert.equal(groups[1]['status'], '5.1.1');
  assert.equal(groups[1]['diagnostic-code'], 'smtp; 550 5.1.1 user unknown');
  assert.equal(groups[2]['final-recipient'], 'c@d.nl');
});

test('synchronous rejections use the same rule: sender / SPF / rate refusals no longer suppress the recipient', () => {
  assert.ok(isAddressStatus('5.1.1') && isAddressStatus('5.1.10') && isAddressStatus('5.2.1') && isAddressStatus('5.4.4'));
  assert.ok(!isAddressStatus('5.1.0') && !isAddressStatus('5.1.7') && !isAddressStatus('5.1.8') && !isAddressStatus('5.2.2') && !isAddressStatus('4.1.1'));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 553, command: 'MAIL FROM', response: '553 5.1.8 <parts@labparts.nl>... Domain of sender address does not exist' }));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 5.1.0 192.0.2.1 is not allowed to send from <labparts.nl> per its SPF Record' }));
  assert.ok(!isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550-5.2.1 The user you are trying to contact is receiving mail at a rate that prevents additional messages' }));
  assert.ok(isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 5.1.2 <x@nonexistent.example>: Recipient address rejected: Domain not found' }));
  assert.ok(isPermanentRecipientFailure({ responseCode: 550, command: 'RCPT TO', response: '550 User not found' }));
});
