import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineVat, type TaxSettings } from '@/lib/tax/determine';
import { offerVatLines, vatExplanation, vatStaffExplanation } from './engine';

const settings: TaxSettings = {
  homeCountry: 'NL', standardRateBp: 2100, shippingFollowsMain: true, icsEnabled: true, icsRequireVies: true,
  viesDownPolicy: 'MANUAL_REVIEW', exportZeroEnabled: true, euB2cMode: 'HOME_RATE', marginSchemeEnabled: true,
  salesMode: 'B2B_ONLY', legalTexts: { ICS: 'ICS', EXPORT: 'EXPORT', MARGIN: 'MARGIN', OSS: 'OSS' },
};
const countries = { isEu: (c: string) => ['NL', 'DE', 'BE'].includes(c), standardRateBp: () => 2100 };

test('offer lines: a margin-scheme line carries its purchase cost; a standard line none', async () => {
  const margin = await offerVatLines({ goodsCents: 50_000, shippingCents: 15_000, scheme: 'MARGIN', productId: null, purchaseCostCents: 42_000 });
  assert.deepEqual(margin, [
    { netCents: 50_000, lineType: 'GOODS', scheme: 'MARGIN', purchaseCostCents: 42_000 },
    { netCents: 15_000, lineType: 'SHIPPING' },
  ]);
  const standard = await offerVatLines({ goodsCents: 50_000, shippingCents: 0, scheme: 'STANDARD', productId: 'p1' });
  assert.deepEqual(standard, [{ netCents: 50_000, lineType: 'GOODS', scheme: 'STANDARD' }]);
  // A sourced item (no listing) without a cost: the engine reports it to staff only.
  const sourced = await offerVatLines({ goodsCents: 50_000, shippingCents: 0, scheme: 'MARGIN', productId: null });
  assert.equal(sourced[0].purchaseCostCents, null);
});

test('margin offer with a recorded cost: the buyer reads only the margin-scheme explanation', async () => {
  const lines = await offerVatLines({ goodsCents: 50_000, shippingCents: 15_000, scheme: 'MARGIN', productId: null, purchaseCostCents: 42_000 });
  const d = determineVat({ shipToCountry: 'NL', billingCountry: 'NL', customerKind: 'BUSINESS', vatId: null, lines }, settings, countries);
  assert.equal(vatExplanation(d), 'Margin scheme for second-hand goods: the VAT is included in the price and not shown separately; VAT 21% is charged on the freight only.');
  assert.doesNotMatch(vatExplanation(d), /purchase cost|Delivery in/);
  assert.match(vatStaffExplanation(d), /Margin-scheme items/);
});
