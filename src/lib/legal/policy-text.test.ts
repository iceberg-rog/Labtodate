import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressFill, cookiePolicyValues, policyContact, privacyPolicyValues, renderPolicyBlocks, type PolicyBlock, type PolicyFacts,
} from './policy-text';
import { COOKIE_POLICY_TOKENS, DEFAULT_COOKIE_POLICY_TEXT, DEFAULT_PRIVACY_POLICY_TEXT, PRIVACY_POLICY_TOKENS } from '../settings/page-texts';

const FACTS: PolicyFacts = {
  site: 'Labtodate',
  legalName: 'Labtodate B.V.',
  addressLines: ['Industrieweg 12', '2712 LB Zoetermeer', 'Netherlands'],
  retentionYears: 7,
  cardPayments: true,
  marketingSoftOptIn: true,
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
