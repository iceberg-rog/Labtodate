import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSettingsLoaded } from '@/lib/settings';
import {
  issueProforma,
  legacyDocumentsAllowed,
  offerItemDetail,
  offerRemarks,
  paymentFacts,
  prePaymentHoldMessage,
  proformaChainHead,
  sellerDetailsMissing,
  sellerIncompleteMessage,
} from './issue';

const CUTOVER = new Date('2026-10-17T23:18:43Z');

test('legacy documents: only for orders created before the cutover, never while the invoice is withheld', () => {
  // The QA case: created after the cutover, value date (paidAt) before it — never legacy.
  assert.equal(legacyDocumentsAllowed({ createdAt: new Date('2026-10-18T00:36:49Z'), openHolds: [], holdReason: null }, CUTOVER), false);
  assert.equal(legacyDocumentsAllowed({ createdAt: new Date('2026-10-01T10:00:00Z'), openHolds: [], holdReason: null }, CUTOVER), true);
  assert.equal(legacyDocumentsAllowed({ createdAt: new Date('2026-10-01T10:00:00Z'), openHolds: ['INVOICE_PENDING'], holdReason: 'INVOICE_PENDING' }, CUTOVER), false);
  assert.equal(legacyDocumentsAllowed({ createdAt: new Date('2026-10-01T10:00:00Z'), openHolds: [], holdReason: 'INVOICE_PENDING' }, CUTOVER), false);
  assert.equal(legacyDocumentsAllowed({ createdAt: new Date('2026-10-01T10:00:00Z'), openHolds: [], holdReason: null }, null), false);
});

const paidOrder = { totalCents: 151_250, financialStatus: 'PAID', amountPaidCents: 0, paidAt: null, paymentVerifiedAt: null, paymentMethodManual: 'BANK_TRANSFER', status: 'PAID' } as const;

test('a short payment accepted within the tolerance is paid in full with the shortfall written off', () => {
  const short = paymentFacts({ ...paidOrder, payments: [{ amountCents: 150_950, receivedAt: new Date('2026-10-17T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never, 500);
  assert.equal(short.inFull, true);
  assert.equal(short.paidCents, 150_950);
  assert.equal(short.writtenOffCents, 300);
  const exact = paymentFacts({ ...paidOrder, payments: [{ amountCents: 151_250, receivedAt: new Date('2026-10-17T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never, 500);
  assert.equal(exact.writtenOffCents, 0);
  const over = paymentFacts({ ...paidOrder, payments: [{ amountCents: 160_000, receivedAt: new Date('2026-10-17T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never, 500);
  assert.equal(over.writtenOffCents, 0);
  // Outside the tolerance: not paid in full, nothing written off.
  const tooShort = paymentFacts({ ...paidOrder, payments: [{ amountCents: 150_000, receivedAt: new Date('2026-10-17T00:00:00Z'), method: 'BANK_TRANSFER' }] } as never, 500);
  assert.equal(tooShort.inFull, false);
  assert.equal(tooShort.writtenOffCents, 0);
});

test('a proforma needs the seller legal name, address, KvK, VAT ID and IBAN', () => {
  const keys = ['COMPANY_LEGAL_NAME', 'COMPANY_ADDRESS', 'COMPANY_KVK', 'COMPANY_VAT', 'BANK_IBAN'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, { COMPANY_LEGAL_NAME: 'Labtodate B.V.', COMPANY_ADDRESS: 'Weg 1\n1000 AA Amsterdam', COMPANY_KVK: '12345678', COMPANY_VAT: 'NL123456789B01', BANK_IBAN: 'NL91ABNA0417164300' });
    assert.deepEqual(sellerDetailsMissing(), []);
    process.env.BANK_IBAN = '';
    process.env.COMPANY_KVK = '  ';
    const missing = sellerDetailsMissing();
    assert.equal(missing.length, 2);
    assert.match(missing.join(' | '), /KvK number \(Settings → Company\) \| IBAN \(Settings → Payments & credit terms\)/);
    assert.match(sellerIncompleteMessage('L2D-2026-X', missing), /No proforma \(payment request\) issued for order L2D-2026-X: .*IBAN.*Issue the proforma now/);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('an unpaid order waiting for the seller details is not payable (no proforma)', () => {
  assert.match(prePaymentHoldMessage({ orderNumber: 'L2D-1', holdReason: 'INVOICE_PENDING', openHolds: ['INVOICE_PENDING'] }) ?? '', /waiting for our payment details to be completed — no proforma/);
  assert.equal(prePaymentHoldMessage({ orderNumber: 'L2D-1', holdReason: null, openHolds: [] }), null);
});

test('the accepted offer: item description and serial on the goods line, the remark only when set', () => {
  const labels = { SERIAL_NO: 'Serial no.' };
  const sr = (offerTerms: unknown, quotedNote: string | null) => ({ sourcingRequest: { offerTerms, quotedNote } }) as never;
  assert.deepEqual(offerItemDetail(sr({ itemDescription: 'Zeiss LSM 980 Airyscan 2, 2021', itemSerial: '2802001234' }, null), labels), ['Zeiss LSM 980 Airyscan 2, 2021', 'Serial no. 2802001234']);
  assert.deepEqual(offerItemDetail(sr(null, 'x'), labels), []);
  assert.deepEqual(offerRemarks(sr(null, '  Delivery incl. installation  ')), ['Delivery incl. installation']);
  assert.deepEqual(offerRemarks(sr(null, '   ')), []);
  // A note that only repeats the item description is not printed twice.
  assert.deepEqual(offerRemarks(sr({ itemDescription: 'Zeiss LSM 980' }, 'Zeiss LSM 980')), []);
  assert.deepEqual(offerRemarks({ sourcingRequest: null } as never), []);
});

test('a replaced proforma names the head of the chain, and "pay it" only when it is payable', async () => {
  const docs: Record<string, { number: string; voidedAt: Date | null; supersededById: string | null }> = {
    r2: { number: 'PF-2026-00013-r2', voidedAt: null, supersededById: 'r3' },
    r3: { number: 'PF-2026-00013-r3', voidedAt: null, supersededById: null },
    v2: { number: 'PF-2026-00020-r2', voidedAt: new Date(), supersededById: null },
    loop: { number: 'PF-LOOP', voidedAt: null, supersededById: 'loop' },
  };
  const find = async (id: string) => docs[id] ?? null;
  assert.deepEqual(await proformaChainHead(find, 'r2'), { number: 'PF-2026-00013-r3', payable: true });
  assert.deepEqual(await proformaChainHead(find, 'v2'), { number: 'PF-2026-00020-r2', payable: false });
  assert.deepEqual(await proformaChainHead(find, 'loop', 5), { number: 'PF-LOOP', payable: false });
  assert.equal(await proformaChainHead(find, 'missing'), null);
});

test('offer acceptance without seller details: only the hold is written, through the acceptance transaction — nothing issued', async () => {
  await ensureSettingsLoaded(); // (loaded first: the env below is not overwritten by stored settings)
  const saved = process.env.BANK_IBAN;
  process.env.BANK_IBAN = '';
  const calls: string[] = [];
  let held: Record<string, unknown> | null = null;
  const order = { id: 'o1', orderNumber: 'L2D-2026-K7Q2M4', status: 'PENDING_PAYMENT', openHolds: [] as string[], holdReason: null, holdNote: null, holdAt: null };
  // The interactive transaction of acceptOffer: every read and write of this step goes through it.
  const tx = {
    order: {
      findUnique: async () => { calls.push('order.findUnique'); return order; },
      update: async (a: { data: Record<string, unknown> }) => { calls.push('order.update'); held = a.data; return order; },
    },
    fiscalDocument: { findFirst: async () => { calls.push('fiscalDocument.findFirst'); return null; } },
  };
  try {
    const r = await issueProforma('o1', { tx: tx as never });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'SELLER_INCOMPLETE');
    assert.ok(!r.ok && r.missing?.includes('IBAN (Settings → Payments & credit terms)'));
    assert.deepEqual(calls.filter((c) => c === 'order.update'), ['order.update']);
    const data = held as unknown as { openHolds: string[]; holdReason: string; payableSince: null; holdNote: string };
    assert.deepEqual(data.openHolds, ['INVOICE_PENDING']);
    assert.equal(data.holdReason, 'INVOICE_PENDING');
    assert.equal(data.payableSince, null);
    assert.match(data.holdNote, /^INVOICE_PENDING: Proforma not issued — missing seller details: .*IBAN/);
  } finally {
    if (saved === undefined) delete process.env.BANK_IBAN;
    else process.env.BANK_IBAN = saved;
  }
});
