/**
 * DB integration tests for the business core (needs Postgres + MinIO from .env,
 * and CHROMIUM_PATH for the PDF part). NOT for production databases: it
 * creates test orders that — by design — can never be deleted afterwards.
 *
 *   node --env-file=.env --import tsx --test scripts/test-business-core.db.ts
 *
 * Covers: gap-free numbering under concurrency (with rollbacks), invoice
 * issuing idempotency under concurrency, immutability triggers, credit notes,
 * VAT review hold, proforma revisions + void-on-cancel, stored-PDF integrity,
 * stock reservation races.
 */
import { assertTestDatabase } from './db-test-guard';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/db';
import { allocateNumber, fiscalYearOf, loadNumberingSettings, type DocSeries } from '../src/lib/documents/numbering';
import { ensureSettingsLoaded } from '../src/lib/settings';
import { issueInvoice, issueCreditNote, issueProforma, reissueProforma, ensureDocumentPdf, getOrderDocuments } from '../src/lib/documents/issue';
import { setViesClient } from '../src/lib/tax/vies';
import { reserveStock, releaseReservation } from '../src/lib/stock/reserve';
import { uploadObject } from '../src/lib/storage/s3';
import { closePdfBrowser } from '../src/lib/documents/pdf';

// Allow-list guard: local test databases only (scripts/db-test-guard.ts).
assertTestDatabase();

const RUN = randomBytes(3).toString('hex').toUpperCase();
let buyerId = '';
async function buyer(): Promise<string> {
  if (buyerId) return buyerId;
  const u = await prisma.user.findFirst({ where: { email: 'qa-buyer@labtodate.test' }, select: { id: true } });
  if (!u) throw new Error('qa-buyer@labtodate.test missing');
  return (buyerId = u.id);
}

async function makeOrder(o: { country: string; vat?: string | null; company?: string | null; subtotal: number; tax: number; shipping?: number; status?: 'PAID' | 'PENDING_PAYMENT'; method?: string }) {
  const n = `L2D-T${RUN}-${randomBytes(2).toString('hex').toUpperCase()}`;
  const paid = (o.status ?? 'PAID') === 'PAID';
  return prisma.order.create({
    data: {
      orderNumber: n,
      buyerId: await buyer(),
      status: o.status ?? 'PAID',
      subtotalCents: o.subtotal,
      shippingCents: o.shipping ?? 0,
      taxCents: o.tax,
      totalCents: o.subtotal + (o.shipping ?? 0) + o.tax,
      paidAt: paid ? new Date() : null,
      amountPaidCents: paid ? o.subtotal + (o.shipping ?? 0) + o.tax : 0,
      paymentMethodManual: o.method ?? (paid ? 'BANK_TRANSFER' : null),
      shippingAddress: { name: 'QA Buyer', company: o.company ?? 'QA Lab B.V.', vat: o.vat ?? null, phone: '+31 10 000 0000', address: { line1: 'Teststraat 1', line2: null, city: 'Delft', state: null, postal_code: '2611 AA', country: o.country } },
      // Real orders carry their billing details (checkout / details before payment).
      billingAddress: { name: 'QA Buyer', company: o.company ?? 'QA Lab B.V.', vat: o.vat ?? null, email: 'ap@qa-lab.example.nl', phone: '+31 10 000 0000', address: { line1: 'Teststraat 1', line2: '', postal_code: '2611 AA', city: 'Delft', state: '', country: o.country } },
      items: { create: { titleSnapshot: `Test centrifuge ${RUN}`, brandSnapshot: 'Eppendorf', priceCentsSnapshot: o.subtotal, quantity: 1 } },
    },
  });
}

after(async () => {
  setViesClient(null);
  await closePdfBrowser();
  await prisma.$disconnect();
});

test('numbering: 40 concurrent issuers, 10 roll back → gap-free, no duplicates', async () => {
  await ensureSettingsLoaded();
  const settings = { ...loadNumberingSettings(), format: 'T-{YYYY}-{SEQ:4}', prefix: { INVOICE: 'T', CREDIT_NOTE: 'T', PROFORMA: 'T' }, start: { INVOICE: 1, CREDIT_NOTE: 1, PROFORMA: 1 } };
  const series = `ZZTEST_${RUN}` as DocSeries;
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, (_, i) =>
      prisma.$transaction(async (tx) => {
        const a = await allocateNumber(tx, series, new Date(), settings);
        await new Promise((r) => setTimeout(r, Math.random() * 30));
        if (i % 4 === 0) throw new Error('rollback');
        return a.seq;
      }, { timeout: 60_000, maxWait: 60_000 }),
    ),
  );
  const committed = results.filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled').map((r) => r.value).sort((a, b) => a - b);
  assert.equal(committed.length, 30);
  assert.deepEqual(committed, Array.from({ length: 30 }, (_, i) => i + 1), 'committed numbers are exactly 1..30');
  const row = await prisma.invoiceSequence.findFirst({ where: { series } });
  assert.equal(row?.nextValue, 31);
  await assert.rejects(prisma.invoiceSequence.update({ where: { id: row!.id }, data: { nextValue: 5 } }), /only move forward/);
});

test('invoice: 8 concurrent issue calls → exactly one invoice, one number', async () => {
  const o = await makeOrder({ country: 'US', subtotal: 250_000, tax: 0 });
  const fy = fiscalYearOf(new Date());
  const seqRow = () => prisma.invoiceSequence.findFirst({ where: { series: 'INVOICE', fiscalYear: { in: [fy, 0] } } });
  const before = (await seqRow())?.nextValue ?? null;
  const rs = await Promise.all(Array.from({ length: 8 }, () => issueInvoice(o.id)));
  assert.ok(rs.every((r) => r.ok), JSON.stringify(rs.find((r) => !r.ok)));
  const numbers = new Set(rs.map((r) => (r.ok ? r.document.number : '')));
  assert.equal(numbers.size, 1);
  assert.equal(rs.filter((r) => r.ok && r.created).length, 1);
  const docs = await getOrderDocuments(o.id);
  assert.ok(docs.invoice);
  assert.equal(docs.invoice!.vatTreatment, 'EXPORT_ZERO');
  const snap = docs.invoice!.snapshot as { vat: { legalText: string }; payment: { kind: string } };
  assert.match(snap.vat.legalText, /Export/);
  assert.equal(snap.payment.kind, 'PAID');
  const afterNext = (await seqRow())!.nextValue;
  if (before != null) assert.equal(afterNext, before + 1, 'exactly one number consumed');
  assert.equal(docs.invoice!.seq, afterNext - 1);
  // The order now records the decision the invoice relied on.
  const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { vatTreatment: true, vatRateBp: true } });
  assert.equal(ord?.vatTreatment, 'EXPORT_ZERO');
  assert.equal(ord?.vatRateBp, 0);
});

test('issued documents are immutable and undeletable (DB triggers)', async () => {
  const o = await makeOrder({ country: 'US', subtotal: 10_000, tax: 0 });
  const r = await issueInvoice(o.id);
  assert.ok(r.ok);
  const id = r.ok ? r.document.id : '';
  await assert.rejects(prisma.fiscalDocument.update({ where: { id }, data: { totalCents: 1 } }), /immutable/);
  await assert.rejects(prisma.fiscalDocument.update({ where: { id }, data: { snapshot: { hacked: true } } }), /immutable/);
  await assert.rejects(prisma.fiscalDocument.update({ where: { id }, data: { voidedAt: new Date() } }), /credit note/);
  await assert.rejects(prisma.fiscalDocument.delete({ where: { id } }), /never be deleted/);
  await assert.rejects(prisma.order.delete({ where: { id: o.id } }), /payment history|Foreign key|violates/i);
});

test('credit note: full credit mirrors the invoice negated; nothing left afterwards', async () => {
  const o = await makeOrder({ country: 'NL', subtotal: 100_000, tax: 21_000 });
  const inv = await issueInvoice(o.id);
  assert.ok(inv.ok, JSON.stringify(inv));
  const cn = await issueCreditNote({ orderId: o.id, reason: 'Test refund' });
  assert.ok(cn.ok, JSON.stringify(cn));
  if (!cn.ok || !inv.ok) return;
  assert.equal(cn.document.totalCents, -inv.document.totalCents);
  assert.equal(cn.document.taxCents, -21_000);
  assert.equal(cn.document.originalDocumentId, inv.document.id);
  assert.match(cn.document.number, /^CN-/);
  const again = await issueCreditNote({ orderId: o.id, reason: 'again' });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.code, 'NOTHING_TO_CREDIT');
  // The invoice itself did not change.
  const invAfter = await prisma.fiscalDocument.findUnique({ where: { id: inv.document.id } });
  assert.deepEqual(invAfter?.snapshot, inv.document.snapshot);
});

test('VAT mismatch: an NL buyer charged 0% is NOT invoiced — order held for VAT review', async () => {
  const o = await makeOrder({ country: 'NL', subtotal: 50_000, tax: 0 });
  const r = await issueInvoice(o.id);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'VAT_REVIEW');
  const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { holdReason: true, holdNote: true } });
  assert.equal(ord?.holdReason, 'VAT_REVIEW');
  assert.match(ord?.holdNote ?? '', /21%/);
  assert.equal((await getOrderDocuments(o.id)).invoice, null);
});

test('intra-EU B2B with a VIES-valid VAT ID: 0% + ICS text + buyer VAT ID on the invoice', async () => {
  setViesClient({ check: async () => ({ status: 'VALID', name: 'QA LAB GMBH', consultationNumber: 'WAPIAAAA-TEST' }) });
  const vat = `DE${String(Date.now()).slice(-9)}`;
  const o = await makeOrder({ country: 'DE', vat, subtotal: 80_000, tax: 0 });
  const r = await issueInvoice(o.id);
  setViesClient(null);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.document.vatTreatment, 'EU_ICS_ZERO');
  const snap = r.document.snapshot as { vat: { legalText: string; buyerVatId: string; viesConsultation: string } };
  assert.match(snap.vat.legalText, /Intra-Community/);
  assert.equal(snap.vat.buyerVatId, vat);
  assert.equal(snap.vat.viesConsultation, 'WAPIAAAA-TEST');
});

test('missing invoice details block issuing (buyer address)', async () => {
  const o = await prisma.order.create({
    data: {
      orderNumber: `L2D-T${RUN}-NOADDR`, buyerId: await buyer(), status: 'PAID', subtotalCents: 1000, taxCents: 0, totalCents: 1000, paidAt: new Date(),
      items: { create: { titleSnapshot: 'x', priceCentsSnapshot: 1000, quantity: 1 } },
    },
  });
  const r = await issueInvoice(o.id);
  assert.equal(r.ok, false);
  // No address → no country → VAT cannot be decided either; both are reasons not to invoice.
  assert.ok(!r.ok && ['VAT_REVIEW', 'MISSING_DETAILS'].includes(r.code));
});

test('proforma: not issued while the billing / delivery details are missing (the amount could still change)', async () => {
  await ensureSettingsLoaded();
  const o = await prisma.order.create({
    data: {
      orderNumber: `L2D-T${RUN}-NODETAILS`, buyerId: await buyer(), status: 'PENDING_PAYMENT', subtotalCents: 1000, taxCents: 210, totalCents: 1210,
      items: { create: { titleSnapshot: 'x', priceCentsSnapshot: 1000, quantity: 1 } },
    },
  });
  const r = await issueProforma(o.id);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.code === 'MISSING_DETAILS', JSON.stringify(r));
  assert.equal((await getOrderDocuments(o.id)).proforma, null);
});

test('proforma: idempotent, revisions supersede, cancel voids it', async () => {
  // Complete details incl. the buyer's VAT ID (Settings: required for EU buyers).
  setViesClient({ check: async () => ({ status: 'VALID', name: 'QA LAB B.V.', consultationNumber: null }) });
  const o = await makeOrder({ country: 'NL', vat: 'NL859876543B01', subtotal: 30_000, tax: 6_300, status: 'PENDING_PAYMENT' });
  const [a, b] = await Promise.all([issueProforma(o.id), issueProforma(o.id)]);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  assert.equal(a.document.id, b.document.id);
  assert.match(a.document.number, /^PF-/);
  const r2 = await reissueProforma(o.id, 'billing address added');
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.document.number, `${a.document.number}-r2`);
  assert.equal(r2.document.version, 2);
  const old = await prisma.fiscalDocument.findUnique({ where: { id: a.document.id } });
  assert.equal(old?.supersededById, r2.document.id);
  await prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELED' } });
  const cur = await prisma.fiscalDocument.findUnique({ where: { id: r2.document.id } });
  assert.ok(cur?.voidedAt, 'the DB trigger voids the open proforma on cancel');
  const ord = await prisma.order.findUnique({ where: { id: o.id }, select: { financialStatus: true } });
  assert.equal(ord?.financialStatus, 'VOID');
  setViesClient(null);
});

test('stored PDF: rendered once from the snapshot, served byte-identical, tampering detected', { skip: !process.env.CHROMIUM_PATH }, async () => {
  const o = await makeOrder({ country: 'US', subtotal: 12_345, tax: 0 });
  const r = await issueInvoice(o.id);
  assert.ok(r.ok);
  if (!r.ok) return;
  const first = await ensureDocumentPdf(r.document.id);
  assert.ok(first.ok, JSON.stringify(first));
  if (!first.ok) return;
  assert.equal(first.rendered, true);
  assert.equal(first.bytes.subarray(0, 4).toString('latin1'), '%PDF');
  const second = await ensureDocumentPdf(r.document.id);
  assert.ok(second.ok && !second.rendered);
  assert.ok(second.ok && Buffer.compare(second.bytes, first.bytes) === 0, 'same stored bytes');
  await uploadObject(first.key, Buffer.from('%PDF-1.4 tampered'), 'application/pdf');
  const tampered = await ensureDocumentPdf(r.document.id);
  assert.equal(tampered.ok, false);
  assert.match(!tampered.ok ? tampered.error : '', /Integrity check failed/);
  await uploadObject(first.key, first.bytes, 'application/pdf'); // restore
});

test('stock: 10 concurrent holds on the last unit → exactly one wins; release restocks once', async () => {
  const src = await prisma.product.findFirst({ where: { status: 'PUBLISHED' }, select: { categoryId: true, sellerId: true } });
  const p = await prisma.product.create({
    data: { slug: `zz-test-stock-${RUN.toLowerCase()}`, title: `ZZ stock test ${RUN}`, status: 'DRAFT', quantity: 1, priceCents: 100, categoryId: src!.categoryId, sellerId: src!.sellerId, images: [] },
  });
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => reserveStock({ productId: p.id, qty: 1, source: 'QUOTE', refId: `q${i}` })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity, 0);
  const winner = rs.find((r) => r.ok) as { ok: true; reservationId: string };
  const [u1, u2] = await Promise.all([
    releaseReservation({ reservationId: winner.reservationId }, 'test'),
    releaseReservation({ reservationId: winner.reservationId }, 'test'),
  ]);
  assert.equal(u1 + u2, 1, 'restocked exactly once');
  assert.equal((await prisma.product.findUnique({ where: { id: p.id } }))?.quantity, 1);
  await prisma.stockReservation.deleteMany({ where: { productId: p.id } });
  await prisma.product.delete({ where: { id: p.id } });
});
