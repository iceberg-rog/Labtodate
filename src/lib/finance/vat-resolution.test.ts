// Server modules import lib/auth-server (React `cache`): the project's test shim provides it outside Next.
import '../../../scripts/react-cache-shim.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vatInvoiceClass, vatUnchangedAfterMove } from './vat-resolution';

const decided = (treatment: string, taxCents: number, rateBp: number) => ({ reviewRequired: false, blocked: false, treatment, taxCents, rateBp });

test('an address change that keeps the VAT amount, rate and legal basis needs no VAT review', () => {
  // The QA case: DOMESTIC_STANDARD on the invoice, the rules now say EU_B2C_HOME — both 21%, €427.35.
  assert.equal(vatUnchangedAfterMove(decided('EU_B2C_HOME', 42_735, 2100), { taxCents: 42_735, vatRateBp: 2100, treatment: 'DOMESTIC_STANDARD' }), true);
  assert.equal(vatUnchangedAfterMove(decided('DOMESTIC_STANDARD', 42_735, 2100), { taxCents: 42_735, vatRateBp: 2100, treatment: 'DOMESTIC_STANDARD' }), true);
  // Orders priced before the VAT rules compare by amount.
  assert.equal(vatUnchangedAfterMove(decided('DOMESTIC_STANDARD', 42_735, 2100), { taxCents: 42_735, vatRateBp: null, treatment: 'LEGACY_UNSPECIFIED' }), true);
});

test('another amount, rate or legal text (0% intra-EU vs export, OSS, margin) does need a review', () => {
  assert.equal(vatUnchangedAfterMove(decided('EXPORT_ZERO', 0, 0), { taxCents: 42_735, vatRateBp: 2100, treatment: 'DOMESTIC_STANDARD' }), false);
  // Same €0, but the invoice must carry another legal text.
  assert.equal(vatUnchangedAfterMove(decided('EXPORT_ZERO', 0, 0), { taxCents: 0, vatRateBp: 0, treatment: 'EU_ICS_ZERO' }), false);
  assert.equal(vatUnchangedAfterMove(decided('EU_B2C_OSS', 42_735, 2100), { taxCents: 42_735, vatRateBp: 2100, treatment: 'EU_B2C_HOME' }), false);
  assert.equal(vatUnchangedAfterMove(decided('DOMESTIC_STANDARD', 42_735, 2100), { taxCents: 42_735, vatRateBp: 900, treatment: 'DOMESTIC_STANDARD' }), false);
  assert.equal(vatUnchangedAfterMove({ ...decided('DOMESTIC_STANDARD', 42_735, 2100), reviewRequired: true }, { taxCents: 42_735, vatRateBp: 2100, treatment: 'DOMESTIC_STANDARD' }), false);
  assert.equal(vatInvoiceClass('MARGIN_SCHEME'), 'MARGIN');
  assert.equal(vatInvoiceClass('REVIEW_REQUIRED'), 'UNKNOWN');
});
