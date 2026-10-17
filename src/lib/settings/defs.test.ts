import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_DEFS, SETTING_GROUPS, settingDef, validateSettingValue, normaliseInput, displayValue, isValidIban, companyVatIdProblem, numberFormatProblem, maskSecret } from './defs';

const v = (key: string, raw: string) => {
  const d = settingDef(key)!;
  return validateSettingValue(d, normaliseInput(d, raw));
};

test('every setting has a known group, a hint, a type, and enum defaults that are valid options', () => {
  const keys = new Set<string>();
  for (const d of SETTING_DEFS) {
    assert.ok(SETTING_GROUPS.includes(d.group), d.key);
    assert.ok(d.hint.length > 10, d.key);
    assert.ok(!keys.has(d.key), `duplicate ${d.key}`);
    keys.add(d.key);
    if (d.default !== undefined) assert.equal(validateSettingValue(d, d.default), null, `default of ${d.key}`);
    if (d.type === 'enum') assert.ok(d.options?.length, d.key);
  }
});

test('the business rules the owner asked for are all configurable', () => {
  for (const k of ['TAX_STANDARD_RATE_PCT', 'TAX_ICS_ZERO_RATE_ENABLED', 'TAX_EXPORT_ZERO_RATE_ENABLED', 'TAX_VIES_DOWN_POLICY', 'TAX_EU_B2C_MODE',
    'TAX_MARGIN_SCHEME_ENABLED', 'INVOICE_NUMBER_FORMAT', 'INVOICE_PREFIX', 'CREDIT_NOTE_PREFIX', 'NUMBERING_RESET_YEARLY', 'INVOICE_START_NUMBER',
    'CREDIT_NOTE_AUTO_ON_REFUND', 'DOC_RETENTION_YEARS', 'AUTO_RESTOCK_ON_REFUND', 'SALES_MODE', 'COMPLIANCE_UNKNOWN_COUNTRY_POLICY', 'SHIPPING_MODE',
    // quotes / offers / payment page (wave 2)
    'OFFER_VALID_DAYS', 'PAYMENT_TERM_DAYS', 'PAYMENT_GRACE_DAYS', 'AUTO_CANCEL_UNPAID', 'PAYMENT_REMINDER_DAYS_BEFORE', 'CREDIT_TERMS_ENABLED',
    'STOCK_RESERVE_ON', 'SELLER_OFFERS_REQUIRE_APPROVAL', 'SELLER_OFFER_MARKUP_PCT', 'BUYER_CAN_CANCEL_UNPAID_ORDER', 'REQUIRE_DETAILS_BEFORE_PAYMENT',
    'OFFER_INCOTERMS', 'OFFER_PAYMENT_TERMS_TEXT', 'QUOTE_SLA_HOURS', 'QUOTE_DECLINE_REASONS']) {
    assert.ok(settingDef(k), k);
  }
});

test('typed validation', () => {
  assert.equal(v('TAX_STANDARD_RATE_PCT', '21'), null);
  assert.equal(v('TAX_STANDARD_RATE_PCT', '25,5'), null);
  assert.match(v('TAX_STANDARD_RATE_PCT', 'twenty') ?? '', /not a percentage/);
  assert.match(v('TAX_STANDARD_RATE_PCT', '60') ?? '', /between/);
  assert.match(v('DOC_RETENTION_YEARS', '5') ?? '', /at least 7/);
  assert.match(v('TAX_VIES_DOWN_POLICY', 'MAYBE') ?? '', /allowed choices/);
  assert.equal(v('TAX_ICS_ZERO_RATE_ENABLED', 'yes'), null);
  assert.match(v('TAX_HOME_COUNTRY', 'Netherlands') ?? '', /2-letter/);
  assert.match(v('OFFER_VALID_DAYS', '0') ?? '', /at least 1/);
  assert.match(v('PAYMENT_REMINDER_DAYS_BEFORE', '3,x') ?? '', /whole numbers/);
  assert.equal(v('PAYMENT_REMINDER_DAYS_BEFORE', '7,3,1'), null);
  assert.match(v('QUOTE_SLA_HOURS', 'VIP:2') ?? '', /NORMAL is required/);
  assert.equal(v('QUOTE_SLA_HOURS', 'VIP:2,URGENT:2,HIGH:8,NORMAL:24,LOW:72'), null);
  assert.match(v('OFFER_CURRENCIES', 'EUR,euro') ?? '', /3-letter/);
  assert.match(v('TERMS_OF_SALE_URL', 'javascript:alert(1)') ?? '', /site path/);
  assert.match(v('BANK_IBAN', 'NL91 ABNA 0417 1643 01') ?? '', /IBAN/);
  assert.equal(v('BANK_IBAN', 'NL91 ABNA 0417 1643 00'), null);
  assert.match(v('INVOICE_PREFIX', 'inv-') ?? '', /capital/);
});

test('money is entered in euros and stored in cents', () => {
  const d = settingDef('DEFAULT_SHIPPING_CENTS')!;
  assert.equal(normaliseInput(d, '12,50'), '1250');
  assert.equal(normaliseInput(d, '€ 45'), '4500');
  assert.equal(displayValue(d, '1250'), '12.50');
});

test('IBAN, VAT ID and number-format checks', () => {
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(isValidIban('DE89 3704 0044 0532 0130 01'), false);
  assert.equal(companyVatIdProblem('NL123456789B01'), null);
  assert.match(companyVatIdProblem('12345678') ?? '', /country code/);
  assert.match(companyVatIdProblem('NL12345678') ?? '', /KvK/);
  assert.equal(numberFormatProblem('{PREFIX}-{YYYY}-{SEQ:5}'), null);
  assert.match(numberFormatProblem('{PREFIX}-{YYYY}') ?? '', /SEQ/);
  assert.match(numberFormatProblem('{PREFIX}-{FOO}-{SEQ}') ?? '', /unknown placeholder/);
});

test('secrets are masked in the change history', () => {
  assert.equal(maskSecret('sk_live_abcdefghijkl1234'), '•••• 1234');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(maskSecret(''), null);
});

test('security policy keys are registered (group Security) with the policy defaults and validation', async () => {
  const { POLICY_DEFS } = await import('../security/policy-defs');
  for (const p of POLICY_DEFS) {
    const d = settingDef(p.key);
    assert.ok(d, `${p.key} missing from the registry`);
    assert.equal(d.group, 'Security', p.key);
    const def = Array.isArray(p.default) ? p.default.join(',') : String(p.default);
    assert.equal(d.default ?? '', def, `default of ${p.key}`);
  }
  assert.match(v('LOCKOUT_BASE_MINUTES', '0') ?? '', /at least 1/);
  assert.match(v('TWO_FACTOR_REQUIRED_ROLES', 'ADMIN,ROOT') ?? '', /unknown option ROOT/);
  assert.equal(v('TWO_FACTOR_REQUIRED_ROLES', 'ADMIN, SELLER'), null);
  assert.match(v('BACKUP_TARGET', 'ftp://x') ?? '', /not valid/);
  assert.equal(v('SMTP_NO_AUTH', 'yes'), null);
});

test('catalog settings are registered with their defaults and validation', async () => {
  const { CATALOG_SETTING_DEFS } = await import('../catalog/settings-defs');
  for (const c of CATALOG_SETTING_DEFS) {
    const d = settingDef(c.key);
    assert.ok(d, `${c.key} missing from the registry`);
    assert.equal(d.group, c.group, c.key);
  }
  assert.equal(settingDef('MISSING_PHOTO_MODE')?.default, 'PLACEHOLDER');
  assert.match(v('MISSING_PHOTO_MODE', 'STOCK_PHOTO') ?? '', /not one of the allowed choices/);
  assert.match(v('RETURN_WINDOW_DAYS', '400') ?? '', /at most 365/);
  assert.equal(v('RETURN_WINDOW_DAYS', ''), null);
  assert.equal(v('INSPECTION_CLAIM_REQUIRES_REPORT', 'off'), null);
  // Import & suppliers: thresholds, mapping rules and texts are validated.
  assert.equal(settingDef('SYNC_PRICE_DROP_REVIEW_PCT')?.default, '30');
  assert.match(v('SYNC_PRICE_DROP_REVIEW_PCT', '0') ?? '', /between 1 and 100/);
  assert.equal(v('SYNC_PRICE_RISE_REVIEW_PCT', '250'), null);
  assert.match(v('IMPORT_CATEGORY_RULES', 'just words') ?? '', /category-slug: keyword/);
  assert.equal(v('IMPORT_CATEGORY_RULES', 'gc: gas chromatograph*, 6890*'), null);
  assert.match(v('IMPORT_BRAND_ALIASES', 'HP Hewlett') ?? '', /alias => Brand/);
  assert.match(v('WARRANTY_MONTHS_FORMAT', 'months of warranty') ?? '', /\{MONTHS\}/);
  assert.match(v('IMPORT_FALLBACK_CATEGORY', 'Parts & modules') ?? '', /slug/);
  assert.equal(settingDef('LEGAL_TERMS_TEXT')?.group, 'Documents & legal texts');
  assert.ok((settingDef('LEGAL_TERMS_TEXT')?.default ?? '').length < 5000, 'terms default fits the 5000-character limit');
});
