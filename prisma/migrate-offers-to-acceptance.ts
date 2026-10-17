/**
 * One-time data migration for the quote → offer → acceptance flow.
 *
 * The old code issued a proforma AND auto-created a PENDING_PAYMENT order the
 * moment staff sent a price ("Proforma issuance IS the order trigger"), so the
 * buyer never accepted anything. With the new flow an order + proforma exist
 * only after the buyer accepts. This script turns those auto-accepted quotes
 * back into OPEN OFFERS awaiting the buyer's acceptance:
 *
 *   quote RESPONDED + proforma fields + an UNPAID auto-created order with no
 *   payment proof (no proof file, never submitted, no Stripe session):
 *     - the order is CANCELED and unlinked from the quote (a note on the order
 *       says why). Quote orders never reserved stock, so nothing is restocked;
 *     - proformaNumber / proformaIssuedAt / paymentInstructionsSnapshot are
 *       cleared (they are issued again when the buyer accepts);
 *     - price, currency, note and validity stay as the offer. An offer past its
 *       validity shows as "expired" — staff re-send it from the quote page.
 *     - a short system message on the thread tells the buyer what changed.
 *   quote RESPONDED + proforma fields and no order at all (e.g. guest quotes):
 *     - proforma fields cleared → plain open offer.
 *
 * NEVER touched: orders that are paid / shipped / refunded, that carry a
 * payment proof (submitted, or a proof file from an earlier rejected attempt),
 * that have a Stripe session, or that are already canceled; and quotes that
 * are ACCEPTED / DECLINED / CLOSED. Those are listed as "skipped".
 *
 * Dry run by default — prints exactly what it would do. Idempotent: once
 * applied, the same quotes no longer match, so a second run reports 0.
 *
 *   npx tsx prisma/migrate-offers-to-acceptance.ts            # dry run
 *   npx tsx prisma/migrate-offers-to-acceptance.ts --apply    # write
 *   ... --apply --notify   also adds an in-app notification for each buyer
 *
 * Self-contained (only @prisma/client), so it also runs in the `setup` image:
 *   docker compose run --rm setup npx tsx prisma/migrate-offers-to-acceptance.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const NOTIFY = process.argv.includes('--notify');

const PAID_LIKE = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'];
const ref = (id: string) => `RFQ-${id.slice(-6).toUpperCase()}`;
const money = (cents: number | null, ccy: string | null) =>
  cents == null ? '—' : `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy || 'EUR'}`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

class Raced extends Error {}

type Plan =
  | { kind: 'reopen'; orderId: string; orderNumber: string; adminNotes: string | null }
  | { kind: 'clear' }
  | { kind: 'skip'; reason: string };

async function main() {
  const now = new Date();
  console.log(`migrate-offers-to-acceptance — ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (nothing is written; add --apply to write)'}`);
  console.log(`Database: ${(process.env.DATABASE_URL || '').replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log('');

  const quotes = await prisma.sourcingRequest.findMany({
    where: {
      status: 'RESPONDED',
      OR: [
        { proformaNumber: { not: null } },
        { proformaIssuedAt: { not: null } },
        { paymentInstructionsSnapshot: { not: null } },
      ],
    },
    select: {
      id: true, proformaNumber: true, buyerEmail: true, submittedById: true,
      quotedPriceCents: true, quotedCurrency: true, validUntilAt: true,
      product: { select: { title: true } }, productCategory: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const orders = quotes.length
    ? await prisma.order.findMany({
        where: { sourcingRequestId: { in: quotes.map((q) => q.id) } },
        select: {
          id: true, orderNumber: true, status: true, sourcingRequestId: true, totalCents: true, currency: true,
          paymentSubmittedAt: true, paymentProofUrl: true, paymentVerificationStatus: true, paidAt: true,
          stripeSessionId: true, adminNotes: true,
          _count: { select: { items: true } },
        },
      })
    : [];
  const orderByQuote = new Map(orders.map((o) => [o.sourcingRequestId!, o]));
  console.log(`Scanned ${quotes.length} RESPONDED quote(s) that still carry proforma data from the old auto-accept flow.`);
  console.log('');

  const rows: Array<{ q: (typeof quotes)[number]; plan: Plan; line: string }> = [];
  for (const q of quotes) {
    const o = orderByQuote.get(q.id);
    const offer = `${money(q.quotedPriceCents, q.quotedCurrency)}, valid until ${day(q.validUntilAt)}${q.validUntilAt && q.validUntilAt < now ? ' (expired → staff can re-send)' : ''}`;
    const head = `${(q.proformaNumber ?? '(no number)').padEnd(16)} ${ref(q.id)}  ${q.buyerEmail}  offer ${offer}`;
    let plan: Plan;
    if (!o) {
      plan = { kind: 'clear' };
    } else if (PAID_LIKE.includes(o.status) || o.paidAt) {
      plan = { kind: 'skip', reason: `order ${o.orderNumber} is ${o.status} — a real sale, left as is` };
    } else if (o.status === 'CANCELED') {
      plan = { kind: 'skip', reason: `order ${o.orderNumber} is already CANCELED — left as is (staff can send a new offer or close the quote)` };
    } else if (o.paymentSubmittedAt || o.paymentProofUrl || o.paymentVerificationStatus) {
      plan = { kind: 'skip', reason: `order ${o.orderNumber} has a payment proof (${o.paymentVerificationStatus ?? 'file on record'}) — left as is, verify or reject it on the order` };
    } else if (o.stripeSessionId) {
      plan = { kind: 'skip', reason: `order ${o.orderNumber} has a Stripe session — left as is, check it by hand` };
    } else if (o.status !== 'PENDING_PAYMENT') {
      plan = { kind: 'skip', reason: `order ${o.orderNumber} is ${o.status} — left as is` };
    } else {
      plan = { kind: 'reopen', orderId: o.id, orderNumber: o.orderNumber, adminNotes: o.adminNotes };
    }
    const tail =
      plan.kind === 'reopen' ? `→ order ${plan.orderNumber} (${money(o!.totalCents, o!.currency)}, PENDING_PAYMENT, no proof) CANCELED + unlinked; proforma cleared; offer reopened`
        : plan.kind === 'clear' ? '→ no order; proforma fields cleared; offer reopened'
        : `→ SKIP: ${plan.reason}`;
    rows.push({ q, plan, line: `  ${head}\n      ${tail}` });
  }

  const groups: Array<[string, Plan['kind']]> = [
    ['Reopen as offers awaiting acceptance (auto-created unpaid order canceled)', 'reopen'],
    ['Reopen as offers awaiting acceptance (no order existed)', 'clear'],
    ['Skipped (never touched)', 'skip'],
  ];
  for (const [title, kind] of groups) {
    const list = rows.filter((r) => r.plan.kind === kind);
    console.log(`${title}: ${list.length}`);
    for (const r of list) console.log(r.line);
    console.log('');
  }

  const todo = rows.filter((r) => r.plan.kind !== 'skip');
  let written = 0;
  let raced = 0;
  if (APPLY) {
    for (const { q, plan } of todo) {
      try {
        await prisma.$transaction(async (tx) => {
          if (plan.kind === 'reopen') {
            // Guarded: only an order that is STILL unpaid with no proof is canceled.
            const cancel = await tx.order.updateMany({
              where: {
                id: plan.orderId, sourcingRequestId: q.id, status: 'PENDING_PAYMENT',
                paymentSubmittedAt: null, paymentProofUrl: null, paidAt: null, stripeSessionId: null,
              },
              data: {
                status: 'CANCELED',
                sourcingRequestId: null,
                adminNotes: `${plan.adminNotes ? `${plan.adminNotes}\n` : ''}[${day(now)}] Canceled by migrate-offers-to-acceptance: auto-created by the old proforma flow before the buyer accepted; never paid. Quote ${ref(q.id)} was reopened as an offer awaiting the buyer's acceptance.`.slice(0, 4000),
              },
            });
            if (cancel.count !== 1) throw new Raced();
          }
          const claim = await tx.sourcingRequest.updateMany({
            where: { id: q.id, status: 'RESPONDED' },
            data: { proformaNumber: null, proformaIssuedAt: null, paymentInstructionsSnapshot: null },
          });
          if (claim.count !== 1) throw new Raced();
          await tx.quoteMessage.create({
            data: {
              sourcingRequestId: q.id,
              fromStaff: true,
              body: plan.kind === 'reopen'
                ? `Your offer is waiting for your decision: review it at the top of this page and accept or decline it. Order ${plan.orderNumber}, which our previous system created automatically before you had accepted, was canceled — no payment is due for it. Accepting the offer creates your order and proforma invoice.`
                : 'Your offer is waiting for your decision: review it at the top of this page and accept or decline it. Accepting creates your order and proforma invoice.',
            },
          });
          await tx.auditLog.create({
            data: {
              actorEmail: 'migrate-offers-to-acceptance',
              action: 'quote.migrate.offer-reopen',
              target: q.proformaNumber ?? ref(q.id),
              meta: plan.kind === 'reopen' ? `order ${plan.orderNumber} canceled + unlinked; proforma cleared` : 'proforma cleared (no order)',
            },
          });
          if (NOTIFY && q.submittedById) {
            await tx.notification.create({
              data: {
                userId: q.submittedById,
                title: 'Your offer is waiting for your decision',
                body: `Review the offer for "${q.product?.title ?? q.productCategory ?? 'your request'}" and accept or decline it.`.slice(0, 500),
                href: `/app/quotes/${q.id}`,
                kind: 'SYSTEM',
              },
            });
          }
        });
        written++;
      } catch (e) {
        if (e instanceof Raced) {
          raced++;
          console.log(`  ! ${q.proformaNumber ?? ref(q.id)} changed while migrating (proof / payment / status) — left untouched`);
          continue;
        }
        throw e;
      }
    }
  }

  console.log('Summary');
  console.log(`  to reopen (order canceled): ${rows.filter((r) => r.plan.kind === 'reopen').length}`);
  console.log(`  to reopen (no order):       ${rows.filter((r) => r.plan.kind === 'clear').length}`);
  console.log(`  skipped:                    ${rows.filter((r) => r.plan.kind === 'skip').length}`);
  if (APPLY) {
    console.log(`  WRITTEN: ${written} quote(s)${raced ? `, ${raced} left untouched because they changed meanwhile` : ''}${NOTIFY ? ' (buyers notified in-app)' : ''}`);
  } else {
    console.log('  Nothing was written (dry run). Re-run with --apply to write these changes.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
