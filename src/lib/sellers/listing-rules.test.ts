import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  companyPriceRule,
  isListingModerator,
  listingChanges,
  liveEditOutcome,
  panelAccess,
  sellerListingPublishProblem,
  type ListingFields,
  type PanelActor,
} from './listing-rules';

const seller: PanelActor = { userId: 's1', role: 'SELLER', caps: [] };
const support: PanelActor = { userId: 'a1', role: 'ADMIN', caps: ['tickets:view', 'tickets:reply', 'tickets:status'] };
const catalog: PanelActor = { userId: 'a2', role: 'ADMIN', caps: ['products:view', 'products:edit'] };
const moderator: PanelActor = { userId: 'a3', role: 'ADMIN', caps: ['products:view', 'products:approve'] };
const superAdmin: PanelActor = { userId: 'a4', role: 'ADMIN', caps: ['*'] };

test('a support-only admin cannot edit, delete or publish another supplier’s listing (D05)', () => {
  for (const action of ['edit', 'delete', 'publish'] as const) {
    const r = panelAccess(support, 's1', action);
    assert.equal(r.ok, false, action);
    assert.match(!r.ok ? r.message : '', /^Forbidden/);
  }
});

test('staff need products:edit to change and products:approve to publish someone else’s listing', () => {
  assert.deepEqual(panelAccess(catalog, 's1', 'edit'), { ok: true, asStaff: true });
  assert.deepEqual(panelAccess(catalog, 's1', 'delete'), { ok: true, asStaff: true });
  assert.equal(panelAccess(catalog, 's1', 'publish').ok, false);
  assert.equal(panelAccess(moderator, 's1', 'edit').ok, false);
  assert.deepEqual(panelAccess(moderator, 's1', 'publish'), { ok: true, asStaff: true });
  assert.deepEqual(panelAccess(superAdmin, 's1', 'publish'), { ok: true, asStaff: true });
});

test('owners act on their own listings; another supplier cannot', () => {
  assert.deepEqual(panelAccess(seller, 's1', 'edit'), { ok: true, asStaff: false });
  assert.deepEqual(panelAccess(support, 'a1', 'publish'), { ok: true, asStaff: false });
  assert.equal(panelAccess({ userId: 's2', role: 'SELLER', caps: ['*'] }, 's1', 'edit').ok, false);
});

test('only an admin with products:approve publishes directly', () => {
  assert.equal(isListingModerator(moderator), true);
  assert.equal(isListingModerator(superAdmin), true);
  assert.equal(isListingModerator(catalog), false);
  assert.equal(isListingModerator(support), false);
  assert.equal(isListingModerator({ userId: 's', role: 'SELLER', caps: ['*'] }), false);
});

test('a supplier listing needs a linked company before it can go live (D84)', () => {
  assert.match(sellerListingPublishProblem({ sellerRole: 'SELLER', companyId: null }) ?? '', /company/);
  assert.equal(sellerListingPublishProblem({ sellerRole: 'SELLER', companyId: 'co1' }), null);
  assert.equal(sellerListingPublishProblem({ sellerRole: 'ADMIN', companyId: null }), null);
});

const live: ListingFields = {
  title: 'Agilent 1260 Infinity II HPLC',
  summary: 'serviced',
  description: '<p>Serviced unit.</p>',
  categoryId: 'c1',
  brandId: 'b1',
  condition: 'REFURBISHED',
  mode: 'BUY_NOW',
  priceCents: 1_000_000,
  currency: 'EUR',
  quantity: 1,
  yearMade: 2019,
  illustration: 'hplc',
  images: ['/media/a.jpg'],
  specs: { Flow: '5 ml/min' },
  warrantyMonths: 6,
  warrantyText: null,
  conditionNotes: null,
  inspectedAt: null,
  inspectionNotes: null,
  shippingClass: 'PALLET',
  weightKg: 80,
  vatScheme: 'STANDARD',
};

test('a typo fix on a live listing keeps it online and flags it for a check (D69)', () => {
  const ch = listingChanges(live, { ...live, summary: 'fully serviced' });
  assert.deepEqual(ch, { commercial: [], content: ['summary'], stock: false });
  assert.equal(liveEditOutcome('PUBLISHED', ch, false), 'flagged');
});

test('price, mode, condition, warranty, inspection and VAT changes send a live listing back to review', () => {
  for (const patch of [
    { priceCents: 990_000 },
    { currency: 'GBP' },
    { mode: 'QUOTE_ONLY' },
    { condition: 'USED' },
    { warrantyMonths: 0 },
    { inspectedAt: '2026-10-01' },
    { vatScheme: 'MARGIN' },
  ] as Array<Partial<ListingFields>>) {
    const ch = listingChanges(live, { ...live, ...patch });
    assert.equal(ch.commercial.length, 1, JSON.stringify(patch));
    assert.equal(liveEditOutcome('PUBLISHED', ch, false), 'review', JSON.stringify(patch));
  }
});

test('stock changes apply at once; nothing changes for drafts or for a moderator', () => {
  const sold = listingChanges(live, { ...live, quantity: 0 });
  assert.deepEqual(sold, { commercial: [], content: [], stock: true });
  assert.equal(liveEditOutcome('PUBLISHED', sold, false), 'none');
  const priced = listingChanges(live, { ...live, priceCents: 1 });
  assert.equal(liveEditOutcome('DRAFT', priced, false), 'none');
  assert.equal(liveEditOutcome('PENDING_REVIEW', priced, false), 'none');
  assert.equal(liveEditOutcome('PUBLISHED', priced, true), 'none');
});

test('equal values in other shapes are no change (trimmed text, empty specs, null vs empty)', () => {
  const ch = listingChanges(
    { ...live, specs: null, summary: null },
    { ...live, specs: {}, summary: '  ' },
  );
  assert.deepEqual(ch, { commercial: [], content: [], stock: false });
});

test('a company’s pricing rule in words, and whether it leaves no margin', () => {
  assert.deepEqual(companyPriceRule('MARKUP_PERCENT', 1500), { rule: 'we add 15 % to the supplier price', noMargin: false });
  assert.deepEqual(companyPriceRule('MARKUP_PERCENT', 1250), { rule: 'we add 12.5 % to the supplier price', noMargin: false });
  assert.equal(companyPriceRule('MARKUP_PERCENT', 0).noMargin, true);
  assert.equal(companyPriceRule('MARKUP_PERCENT', -500).noMargin, true);
  assert.deepEqual(companyPriceRule('PASS_THROUGH', 0), { rule: 'supplier price passed through: no margin', noMargin: true });
  assert.equal(companyPriceRule('FORCE_QUOTE', 0).noMargin, false);
  assert.equal(companyPriceRule('HIDE_PRICE', 0).noMargin, false);
});
