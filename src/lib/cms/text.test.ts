import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks, checkText, fillPlain, fillRich, fillRichPlain, placeholdersIn, safeHref, stripLinks, unknownPlaceholders } from './text';

test('placeholders are found and checked', () => {
  assert.deepEqual(placeholdersIn('Hi {{customer.name}}, {{ Document.Number }} {{customer.name}}'), ['customer.name', 'document.number']);
  assert.deepEqual(unknownPlaceholders('{{customer.nmae}} {{site.url}}', ['site.url', 'customer.name']), ['customer.nmae']);
  assert.equal(checkText('Intro', '{{customer.name', ['customer.name']).length, 1);
  assert.equal(checkText('Intro', 'Fine {{customer.name}}', ['customer.name']).length, 0);
  assert.equal(checkText('Title', '', [], { required: true }).length, 1);
});

test('values and typed HTML are escaped', () => {
  const html = fillRich('<b>Hello</b> {{customer.name}}', { 'customer.name': '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;Hello&lt;/b&gt;'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('bold, paragraphs, line breaks and lists', () => {
  const html = fillRich('**Total:** x\nline two\n\n- one\n- two', {});
  assert.equal(html, '<p><strong>Total:</strong> x<br>line two</p><ul><li>one</li><li>two</li></ul>');
});

test('a line of only empty placeholders is dropped', () => {
  const html = fillRich('Dear X,\n\n{{payment.instructions}}\n\nBye', { 'payment.instructions': '' });
  assert.equal(html, '<p>Dear X,</p><p>Bye</p>');
  const kept = fillRich('{{payment.instructions}}', { 'payment.instructions': 'IBAN NL00\nRef PRO-1' });
  assert.equal(kept, '<p>IBAN NL00<br>Ref PRO-1</p>');
});

test('plain variants', () => {
  assert.equal(fillPlain('Quote {{quote.number}}', { 'quote.number': 'PRO-2026-0001' }), 'Quote PRO-2026-0001');
  assert.equal(fillRichPlain('**Total:** {{x}}', { x: '€ 5' }), 'Total: € 5');
});

test('links only where turned on, and only to safe targets', () => {
  // Documents and e-mails (no `links`): the markup stays literal text.
  assert.equal(fillRich('See [terms](/legal/terms).', {}), '<p>See [terms](/legal/terms).</p>');
  assert.equal(fillRich('See [terms](/legal/terms).', {}, { links: true }), '<p>See <a href="/legal/terms">terms</a>.</p>');
  assert.equal(fillRich('[**Mail** us](mailto:{{e}})', { e: 'a@b.com' }, { links: true }), '<p><a href="mailto:a@b.com"><strong>Mail</strong> us</a></p>');
  // Unsafe targets keep the label, without a link.
  for (const bad of ['javascript:alert(1)', '//evil.com', '/\\evil.com', 'data:text/html,x', 'https://x.com/"onmouseover=1']) {
    assert.equal(safeHref(bad), null, bad);
    assert.ok(!fillRich(`[x](${bad})`, {}, { links: true }).includes('<a '), bad);
  }
  assert.equal(safeHref('https://www.linkedin.com/company/x'), 'https://www.linkedin.com/company/x');
  assert.equal(safeHref('#categories'), '#categories');
  // A link field renders as a ready link; an empty value drops the line like any field.
  const contact = { 'support.contact': { href: 'mailto:help@x.com', label: 'help@x.com' } };
  assert.equal(fillRich('Write to {{support.contact}}.', {}, { linkVars: contact }), '<p>Write to <a href="mailto:help@x.com">help@x.com</a>.</p>');
  assert.equal(fillRich('{{support.contact}}', {}, { linkVars: { 'support.contact': { href: '/contact', label: '' } } }), '');
  assert.equal(stripLinks('A [b](/c) d'), 'A b d');
});

test('checkLinks refuses unsafe targets and accepts field-based ones', () => {
  assert.deepEqual(checkLinks('X', '[a](/sell) [b](mailto:{{support.email}}) [c]({{site.url}}/faq) [d](https://example.com)'), []);
  assert.equal(checkLinks('X', '[a](javascript:alert)').length, 1);
  assert.equal(checkLinks('X', '[a](//evil.com)').length, 1);
});
