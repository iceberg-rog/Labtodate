import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks, checkText, fillRich } from '@/lib/cms/text';
import { SITE_GROUPS, siteDef } from './defs';
import { SITE_FIELDS } from './types';

const fieldNames = SITE_FIELDS.map((f) => f.name);
const allFields = SITE_GROUPS.flatMap((g) => g.fields.map((f) => ({ group: g, f })));

test('group ids and field keys are unique, and every key starts with its group id', () => {
  const ids = SITE_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate group id in ${ids.join(', ')}`);
  const keys = allFields.map(({ f }) => f.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], `duplicate keys: ${dupes.join(', ')}`);
  for (const { group, f } of allFields) assert.ok(f.key.startsWith(`${group.id}.`), `${f.key} is not under group ${group.id}`);
});

test('SITE_FIELDS names are unique', () => {
  assert.equal(new Set(fieldNames).size, fieldNames.length);
});

test('every text default is valid as saved by the admin (fields, length, links, required)', () => {
  for (const { f } of allFields) {
    if (f.kind !== 'text' && f.kind !== 'rich' && f.kind !== 'page') continue;
    const label = `${f.key} (${f.label})`;
    if (f.format === 'url') {
      assert.ok(f.default === '' || /^https:\/\//.test(f.default), `${label}: default must be empty or https://`);
      continue;
    }
    const max = f.max ?? (f.kind === 'page' ? 30_000 : 2_000);
    assert.deepEqual(checkText(label, f.default, fieldNames, { max, required: f.required }), [], label);
    assert.deepEqual(checkLinks(label, f.default), [], label);
  }
});

test('select, toggle and number defaults are allowed values', () => {
  for (const { f } of allFields) {
    if (f.kind === 'select') {
      assert.ok(f.options?.length, `${f.key}: no options`);
      assert.ok(f.options!.some((o) => o.value === f.default), `${f.key}: default “${f.default}” is not an option`);
    }
    if (f.kind === 'toggle') assert.ok(f.default === 'on' || f.default === 'off', `${f.key}: toggle default must be on/off`);
    if (f.kind === 'number') {
      const n = Number(f.default);
      assert.ok(Number.isInteger(n) && n >= (f.min ?? 0) && n <= (f.maxValue ?? 1_000_000), `${f.key}: default out of range`);
    }
  }
});

test('`needs` only names the three claims', () => {
  for (const { f } of allFields) {
    for (const n of f.needs ?? []) assert.ok(['claims.warranty', 'claims.inspection', 'claims.quote_turnaround'].includes(n), `${f.key}: needs ${n}`);
  }
});

test('page groups have a title and a page body and link to their page', () => {
  for (const g of SITE_GROUPS.filter((x) => x.id.startsWith('page_') && x.id !== 'page_contact')) {
    assert.ok(g.page?.startsWith('/'), `${g.id}: page link`);
    assert.equal(siteDef(`${g.id}.title`)?.def.kind, 'text');
    assert.equal(siteDef(`${g.id}.body`)?.def.kind, 'page');
  }
});

test('the built-in Terms quote the rules, not fixed numbers, and §4 is a whole sentence', () => {
  const terms = siteDef('page_terms.body')!.def.default;
  assert.ok(terms.includes('valid for {{rules.quote_valid_days}} days'));
  assert.ok(!/\b(14|7) days\b/.test(terms), 'no hard-coded day counts');
  assert.ok(terms.includes('{{rules.return_days}} days'));
  const s4 = terms.split('## 4.')[1].split('## 5.')[0];
  assert.ok(!/if any,\s*covering/.test(s4), '§4 broken sentence is fixed');
  const faq = siteDef('page_faq.body')!.def.default;
  assert.ok(faq.includes('{{rules.return_days}} days'));
  assert.ok(!/\b7 days\b/.test(faq));
});

test('built-in pages render: headings, lists, links, escaped text', () => {
  const vars = Object.fromEntries(SITE_FIELDS.map((f) => [f.name, f.example]));
  const contact = { 'support.contact': { href: 'mailto:support@labtodate.com', label: 'support@labtodate.com' } };
  const html = fillRich(siteDef('page_faq.body')!.def.default, vars, { headings: true, links: true, linkVars: contact });
  assert.ok(html.startsWith('<h2>Is the equipment tested?</h2>'));
  assert.ok(html.includes('<a href="/sell">Sell equipment</a>'));
  assert.ok(html.includes('<a href="mailto:support@labtodate.com">support@labtodate.com</a>'));
  assert.ok(html.includes('within 7 days of delivery'));
  const cookies = fillRich(siteDef('page_cookies.body')!.def.default, vars, { headings: true, links: true, linkVars: contact });
  assert.ok(cookies.includes('<li><strong>Session / authentication</strong> — keeps you signed in to your account.</li>'));
  const privacy = fillRich(siteDef('page_privacy.body')!.def.default, vars, { headings: true });
  assert.ok(privacy.includes('Labtodate B.V. (“Labtodate”) is the data controller'));
  assert.ok(!privacy.includes('<script'));
});
