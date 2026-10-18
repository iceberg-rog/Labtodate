import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  addressFill, cookiePolicyValues, POLICY_SOURCES, policyContact, policyRevisionDate, privacyPolicyValues, renderPolicyBlocks,
  teamNotificationsAddedAt, teamNotificationServices, type PolicyBlock, type PolicyFacts,
} from './policy-text';
import {
  COOKIE_POLICY_TOKENS, DEFAULT_COOKIE_POLICY_DATE, DEFAULT_COOKIE_POLICY_TEXT, DEFAULT_PRIVACY_POLICY_DATE, DEFAULT_PRIVACY_POLICY_TEXT,
  PRIVACY_POLICY_TOKENS,
} from '../settings/page-texts';
import { settingDef } from '../settings/defs';

const FACTS: PolicyFacts = {
  site: 'Labtodate',
  legalName: 'Labtodate B.V.',
  addressLines: ['Industrieweg 12', '2712 LB Zoetermeer', 'Netherlands'],
  retentionYears: 7,
  cardPayments: true,
  marketingSoftOptIn: true,
  teamNotificationServices: [],
};

/** The page as plain text: headings and paragraphs, the contact link as [CONTACT], site links as label<href>. */
function plain(blocks: PolicyBlock[]): string {
  return blocks
    .map((b) => (b.kind === 'h2' ? '## ' : '') + b.parts.map((p) => ('contact' in p ? '[CONTACT]' : 'href' in p ? `${p.text}<${p.href}>` : p.text)).join(''))
    .join('\n');
}

const privacy = (f: Partial<PolicyFacts> = {}, text = DEFAULT_PRIVACY_POLICY_TEXT) => plain(renderPolicyBlocks(text, privacyPolicyValues({ ...FACTS, ...f })));
const cookies = (f: Partial<PolicyFacts> = {}, text = DEFAULT_COOKIE_POLICY_TEXT) => plain(renderPolicyBlocks(text, cookiePolicyValues({ ...FACTS, ...f })));

test('the value builders fill exactly the placeholders each page lists ({CONTACT} stays the link)', () => {
  assert.deepEqual(Object.keys(privacyPolicyValues(FACTS)).sort(), PRIVACY_POLICY_TOKENS.filter((t) => t !== '{CONTACT}').sort());
  assert.deepEqual(Object.keys(cookiePolicyValues(FACTS)).sort(), COOKIE_POLICY_TOKENS.filter((t) => t !== '{CONTACT}').sort());
  assert.doesNotMatch(privacy(), /\{[A-Z_]+\}/, 'no placeholder left on the privacy page');
  assert.doesNotMatch(cookies(), /\{[A-Z_]+\}/, 'no placeholder left on the cookie page');
});

test('privacy: names the e-mail provider, hosting and storage, VIES, carriers and the retention period', () => {
  const p = privacy();
  assert.match(p, /^Labtodate B\.V\., Industrieweg 12, 2712 LB Zoetermeer, Netherlands \(“Labtodate”\) is the data controller/);
  assert.match(p, /E-mail: our e-mail provider delivers/);
  assert.match(p, /Hosting and storage: the site, its database and uploaded files/);
  assert.match(p, /VIES service/);
  assert.match(p, /Shipping: the carrier/);
  assert.match(p, /kept for 7 years/);
  assert.match(privacy({ retentionYears: 10 }), /kept for 10 years/);
  assert.match(p, /\[CONTACT\]/);
  assert.match(p, /e-mail preferences<\/app\/email-preferences>/, 'the preferences link is a link');
});

test('privacy: the card payment provider is named only while card payment is offered, in its own paragraph', () => {
  const on = privacy();
  assert.match(on, /\nCard payments: when you pay by card, you enter your card details on the payment page of Stripe/);
  assert.match(on, /your e-mail address, the items, the amount and the order number/);
  const off = privacy({ cardPayments: false });
  assert.doesNotMatch(off, /Stripe|Card payments/);
  assert.doesNotMatch(off, /\n\n|\n$/, 'no empty paragraph is left behind');
  // An owner who kept the placeholder inline after a sentence still gets a space before it.
  assert.match(privacy({}, 'We check VAT IDs.{CARD_PAYMENTS}'), /^We check VAT IDs\. Card payments: /);
});

test('privacy: the marketing paragraph follows the soft opt-in, and no AI provider or chat is named', () => {
  assert.match(privacy({ marketingSoftOptIn: true }), /If you bought from us, we may e-mail you offers/);
  assert.match(privacy({ marketingSoftOptIn: false }), /Only if you opted in do we also e-mail you news and offers/);
  assert.doesNotMatch(privacy(), /\bAI\b|OpenAI|Anthropic|assistant|chat/i);
});

test('privacy: the chat services that get staff notices are named only while an active webhook posts them', () => {
  const none = privacy();
  assert.doesNotMatch(none, /Team notifications|Slack|Discord|Telegram/);
  assert.doesNotMatch(none, /\n\n|\n$/, 'no empty paragraph is left behind');
  const one = privacy({ teamNotificationServices: ['Slack'] });
  assert.match(one, /\nTeam notifications: our staff receive notices about orders, quotes, payments, support tickets and sign-in security in Slack\. /);
  assert.match(one, /your name or company name, the subject or an excerpt of your message/);
  assert.match(one, /your e-mail address and IP address; the provider of that service receives and stores these notices\.\n/);
  // Its own paragraph after the processors, so “Each of them processes …” does not cover it.
  assert.match(one, /Each of them processes the data only to perform that task for us\.\nTeam notifications: /);
  const three = privacy({ teamNotificationServices: ['Discord', 'Slack', 'Telegram'] });
  assert.match(three, / in Discord, Slack and Telegram\. /);
  assert.match(three, /the providers of these services receive and store these notices\./);
});

test('team notifications: each delivering webhook kind once, sorted; a Telegram hook without a chat id sends nothing', () => {
  assert.deepEqual(teamNotificationServices([]), []);
  assert.deepEqual(
    teamNotificationServices([
      { kind: 'TELEGRAM', chatId: '-100123' },
      { kind: 'SLACK', chatId: null },
      { kind: 'SLACK', chatId: null },
      { kind: 'DISCORD', chatId: null },
    ]),
    ['Discord', 'Slack', 'Telegram'],
  );
  assert.deepEqual(teamNotificationServices([{ kind: 'TELEGRAM', chatId: null }, { kind: 'TELEGRAM', chatId: ' ' }, { kind: 'TEAMS', chatId: null }]), []);
});

test('team notifications: the date the last named service was added (its oldest hook), null without hooks', () => {
  const d = (s: string) => new Date(s);
  assert.equal(teamNotificationsAddedAt([]), null);
  const at = teamNotificationsAddedAt([
    { kind: 'SLACK', chatId: null, createdAt: d('2026-03-01') },
    { kind: 'SLACK', chatId: null, createdAt: d('2026-09-01') }, // a second Slack hook changes nothing on the page
    { kind: 'DISCORD', chatId: null, createdAt: d('2026-05-01') },
    { kind: 'TELEGRAM', chatId: null, createdAt: d('2026-10-01') }, // sends nothing
  ]);
  assert.deepEqual(at, d('2026-05-01'));
});

test('“Last updated”: the text in use, or a later recorded change of what fills it in — never today', () => {
  const d = (s: string) => new Date(s);
  const base = { defaultTextDate: d('2026-10-18') };
  assert.deepEqual(policyRevisionDate({ ...base, textUpdatedAt: null, changes: [] }), d('2026-10-18'), 'default text: its date');
  assert.deepEqual(policyRevisionDate({ ...base, textUpdatedAt: d('2026-06-02'), changes: [null, undefined] }), d('2026-06-02'), 'edited text: when it was saved');
  assert.deepEqual(policyRevisionDate({ ...base, textUpdatedAt: d('2026-06-02'), changes: [d('2026-08-09'), d('2026-07-01')] }), d('2026-08-09'));
  assert.deepEqual(policyRevisionDate({ ...base, textUpdatedAt: null, changes: [d('2026-01-01')] }), d('2026-10-18'), 'an older change does not move it');
});

test('“Last updated”: every setting a page is filled from is a registry key', () => {
  for (const [page, src] of Object.entries(POLICY_SOURCES)) {
    for (const key of [src.textKey, ...src.factKeys]) assert.ok(settingDef(key), `${page}: ${key}`);
  }
  assert.ok(POLICY_SOURCES.privacy.webhooks && !POLICY_SOURCES.cookies.webhooks);
});

test('a changed default text comes with a new default date', () => {
  // Edited DEFAULT_PRIVACY_POLICY_TEXT or DEFAULT_COOKIE_POLICY_TEXT? Set its
  // *_DATE (lib/settings/page-texts.ts) to the day of the change — it is the
  // page’s “Last updated” — then update the fingerprint and date here.
  const fp = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 16);
  assert.deepEqual({ text: fp(DEFAULT_PRIVACY_POLICY_TEXT), date: DEFAULT_PRIVACY_POLICY_DATE }, { text: '90a804691610123e', date: '2026-10-18' });
  assert.deepEqual({ text: fp(DEFAULT_COOKIE_POLICY_TEXT), date: DEFAULT_COOKIE_POLICY_DATE }, { text: '337e60bb0704f8d1', date: '2026-10-18' });
  for (const date of [DEFAULT_PRIVACY_POLICY_DATE, DEFAULT_COOKIE_POLICY_DATE]) assert.ok(!Number.isNaN(Date.parse(date)), date);
});

test('privacy: without a registered address the controller line has no dangling comma', () => {
  assert.match(privacy({ legalName: 'Labtodate', addressLines: [] }), /^Labtodate \(“Labtodate”\) is the data controller/);
  assert.equal(addressFill([]), '');
  assert.equal(addressFill([' Street 1 ', '', 'NL']), ', Street 1, NL');
});

test('cookies: the sign-in cookies only — no chat cookie — and the card page cookies while card payment is offered', () => {
  const c = cookies();
  assert.match(c, /^Labtodate uses only the cookies needed/);
  assert.match(c, /Sign-in session/);
  assert.match(c, /Two-step sign-in/);
  assert.doesNotMatch(c, /lab2_asst|assistant|chat/i);
  assert.match(c, /payment page of Stripe, our payment provider, which sets its own cookies there\./);
  assert.doesNotMatch(cookies({ cardPayments: false }), /Stripe|pay by card/);
});

test('an edited text is what the page shows: headings, paragraphs, contact and site links', () => {
  const blocks = renderPolicyBlocks('Hello {SITE}.\n\n## Ask us\nWrite to {CONTACT} or see [our terms](/legal/terms).', privacyPolicyValues(FACTS));
  assert.deepEqual(blocks, [
    { kind: 'p', parts: [{ text: 'Hello Labtodate.' }] },
    { kind: 'h2', parts: [{ text: 'Ask us' }] },
    { kind: 'p', parts: [{ text: 'Write to ' }, { contact: true }, { text: ' or see ' }, { text: 'our terms', href: '/legal/terms' }, { text: '.' }] },
  ]);
});

test('links to other sites or schemes stay plain text', () => {
  for (const href of ['https://evil.example', '//evil.example', 'javascript:alert(1)', 'mailto:x@y.z']) {
    const blocks = renderPolicyBlocks(`See [this](${href}).`, {});
    assert.deepEqual(blocks, [{ kind: 'p', parts: [{ text: `See [this](${href}).` }] }], href);
  }
});

test('contact: the support e-mail, else the company e-mail, else the contact page', () => {
  assert.deepEqual(policyContact('support@labtodate.com', 'billing@labtodate.com'), { href: 'mailto:support@labtodate.com', label: 'support@labtodate.com' });
  assert.deepEqual(policyContact('', 'billing@labtodate.com'), { href: 'mailto:billing@labtodate.com', label: 'billing@labtodate.com' });
  assert.deepEqual(policyContact(' ', ''), { href: '/contact', label: 'our contact page' });
});
