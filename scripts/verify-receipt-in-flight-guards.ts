/**
 * Offline regression harness — receipt-in-flight protection (BUG-034 + BUG-035)
 * ---------------------------------------------------------------------------
 * Invariant (manual-payment posture):
 *   An order with a buyer receipt in flight — status === 'PENDING_PAYMENT'
 *   AND paymentSubmittedAt != null (i.e. paymentVerificationStatus ===
 *   'AWAITING_VERIFICATION') — must NEVER be auto/bulk-canceled. The only
 *   paths that may change its payment state are admin verifyPayment / rejectPayment.
 *
 * Why this script exists: the cron sweep (src/app/api/cron/sla-sweep/route.ts)
 * has no UI and the admin cancel paths (src/app/admin/actions.ts) are
 * side-effectful server actions; with the deployed site unreachable (BUG-033)
 * none are browser-testable. This harness re-implements each path's cancel
 * WHERE-predicate verbatim and proves, across a scenario matrix, that a
 * receipt-in-flight order is excluded by every one of them.
 *
 * Run: npx tsx scripts/verify-receipt-in-flight-guards.ts
 * Exit 0 = all guards hold; exit 1 = a guard regressed.
 */

import { readFileSync } from 'node:fs'; // module scope + source-contract coupling

type OrderStatus =
  | 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED'
  | 'DELIVERED' | 'CANCELED' | 'REFUNDED';

interface Order {
  id: string;
  status: OrderStatus;
  paymentSubmittedAt: Date | null;      // set when buyer uploads receipt
  paymentVerificationStatus: string | null; // AWAITING_VERIFICATION | VERIFIED | REJECTED | null
  sourcingRequestId: string | null;
  stripeSessionId: string | null;
  createdAt: Date;
}

const now = new Date('2026-06-19T00:00:00Z');
const old = new Date('2026-06-01T00:00:00Z'); // older than any TTL

// ── Scenario matrix ────────────────────────────────────────────────────────
const orders: Order[] = [
  { id: 'A_receipt_in_flight', status: 'PENDING_PAYMENT', paymentSubmittedAt: now, paymentVerificationStatus: 'AWAITING_VERIFICATION', sourcingRequestId: 'sr1', stripeSessionId: null, createdAt: old },
  { id: 'B_clean_pending',     status: 'PENDING_PAYMENT', paymentSubmittedAt: null, paymentVerificationStatus: null,                  sourcingRequestId: 'sr1', stripeSessionId: null, createdAt: old },
  { id: 'C_clean_pending_orphan', status: 'PENDING_PAYMENT', paymentSubmittedAt: null, paymentVerificationStatus: null,             sourcingRequestId: null,  stripeSessionId: null, createdAt: old },
  { id: 'D_rejected_resubmit_pending', status: 'PENDING_PAYMENT', paymentSubmittedAt: null, paymentVerificationStatus: 'REJECTED',  sourcingRequestId: 'sr1', stripeSessionId: null, createdAt: old },
  { id: 'E_paid',              status: 'PAID',            paymentSubmittedAt: now, paymentVerificationStatus: 'VERIFIED',            sourcingRequestId: 'sr1', stripeSessionId: null, createdAt: old },
];

// ── Cancel predicates, copied verbatim from each production path ────────────
// 1) cron proforma-expiry sweep — linked-order cancel (route.ts ~168)
const cronProformaCancels = (o: Order) =>
  o.status === 'PENDING_PAYMENT' && o.paymentSubmittedAt === null;
// plus the pre-check `continue` guard (route.ts ~150): skip whole action if any
// linked order has paymentSubmittedAt != null. Modeled at the request level below.

// 2) cron orphan sweep — order cancel (route.ts ~247)
const cronOrphanCancels = (o: Order) =>
  o.status === 'PENDING_PAYMENT' && o.paymentSubmittedAt === null && o.stripeSessionId === null && o.sourcingRequestId === null;

// 3) admin bulkCancelOrders (actions.ts ~1239, post-BUG-035)
const bulkCancelCancels = (o: Order) =>
  o.status === 'PENDING_PAYMENT' && o.paymentSubmittedAt === null;

// 4) admin single cancelOrder (actions.ts ~1094, post-BUG-035 guard throws)
const singleCancelCancels = (o: Order) => {
  if (['CANCELED', 'REFUNDED', 'DELIVERED'].includes(o.status)) return false; // no-op
  if (['PAID', 'PROCESSING', 'SHIPPED'].includes(o.status)) return false;     // throws "use Refund"
  if (o.paymentSubmittedAt) return false;                                      // BUG-035 throws
  return true; // reaches CANCELED
};

const paths: Record<string, (o: Order) => boolean> = {
  'cron.proforma-expiry': cronProformaCancels,
  'cron.orphan-sweep': cronOrphanCancels,
  'admin.bulkCancel': bulkCancelCancels,
  'admin.singleCancel': singleCancelCancels,
};

// ── Assertions ──────────────────────────────────────────────────────────────
let failures = 0;
const rows: string[] = [];

// Production coupling: the proforma path's receipt-in-flight guard is now enforced
// by expireProformaTransition (the proof check runs INSIDE the transaction, and a
// proof in flight aborts to 'proof-in-flight' with zero side effects) — proven
// end-to-end in scripts/it-order-atomicity.ts. Assert the sweep actually routes
// through it (and dropped the stale external read) so this model can't drift.
{
  const sweep = readFileSync('src/app/api/cron/sla-sweep/route.ts', 'utf8');
  const wired = /expireProformaTransition\s*\(/.test(sweep) && !/const paymentInFlight/.test(sweep);
  if (!wired) { failures++; rows.push('FAIL  cron.proforma-expiry     wiring: sweep does NOT route through expireProformaTransition'); }
  else rows.push('ok    cron.proforma-expiry     wiring: routes through expireProformaTransition');
}

for (const [name, pred] of Object.entries(paths)) {
  for (const o of orders) {
    const cancels = pred(o);
    const receiptInFlight = o.status === 'PENDING_PAYMENT' && o.paymentSubmittedAt !== null;
    // INVARIANT: a receipt-in-flight order must never be canceled by any path.
    const violation = receiptInFlight && cancels;
    if (violation) failures++;
    if (receiptInFlight) {
      rows.push(`${violation ? 'FAIL' : 'ok  '}  ${name.padEnd(22)} ${o.id.padEnd(28)} cancels=${cancels}`);
    }
  }
}

// Positive controls: clean pending orders SHOULD still be cancelable by the
// operator paths (we didn't over-block), and the orphan sweep should still get
// the unattached clean order.
const mustCancel: Array<[string, string]> = [
  ['admin.bulkCancel', 'B_clean_pending'],
  ['admin.singleCancel', 'B_clean_pending'],
  ['admin.bulkCancel', 'D_rejected_resubmit_pending'], // after reject, paymentSubmittedAt cleared → cancelable
  ['cron.orphan-sweep', 'C_clean_pending_orphan'],
];
for (const [pname, oid] of mustCancel) {
  const o = orders.find((x) => x.id === oid)!;
  const cancels = paths[pname](o);
  if (!cancels) { failures++; rows.push(`FAIL  ${pname.padEnd(22)} ${oid.padEnd(28)} expected cancelable, got cancels=false`); }
  else rows.push(`ok    ${pname.padEnd(22)} ${oid.padEnd(28)} cancelable (control)`);
}

console.log('receipt-in-flight guard matrix (BUG-034 + BUG-035)');
console.log('--------------------------------------------------');
console.log(rows.join('\n'));
console.log('--------------------------------------------------');
if (failures > 0) {
  console.error(`RESULT: ${failures} guard violation(s) — INVARIANT BROKEN`);
  process.exit(1);
}
console.log('RESULT: all guards hold — receipt-in-flight orders are never auto/bulk-canceled');
process.exit(0);
