// Offline regression matrix for BUG-037 (invariant F15 / manual-payment posture).
//
// rejectPayment used a snapshot read + in-memory AWAITING_VERIFICATION guard
// followed by an UNCONDITIONAL `prisma.order.update({ where:{ id } })` and then
// fired buyer/admin notifications, email and audit unconditionally. Its sibling
// verifyPayment already claims the transition atomically (`updateMany` with the
// status precondition in the WHERE) and gates all side effects on count===1.
//
// This harness models a faithful "both requests snapshot before either write
// lands" race against the OLD (unconditional update) and NEW (conditional
// updateMany + count gate) reject logic, plus a double-click reject, and asserts:
//   - NEW: a concurrent verify wins; reject no-ops (no overwrite, no email).
//   - NEW: double-click reject notifies exactly once.
//   - OLD: reject overwrites a just-verified PAID order -> PAID+REJECTED corruption
//          (F15 regression) and double-click reject double-notifies (defect repro).
//
// Run: node --experimental-strip-types scripts/verify-reject-payment-atomic.ts
export {};

type VerStatus = 'AWAITING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | null;
type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'CANCELED';

interface Order {
  id: string;
  status: OrderStatus;
  paidAt: number | null;
  paymentVerificationStatus: VerStatus;
  paymentVerifiedAt: number | null;
  paymentVerifiedById: string | null;
  paymentSubmittedAt: number | null;
  paymentRejectionReason: string | null;
}

function freshOrder(): Order {
  return {
    id: 'o1',
    status: 'PENDING_PAYMENT',
    paidAt: null,
    paymentVerificationStatus: 'AWAITING_VERIFICATION',
    paymentVerifiedAt: null,
    paymentVerifiedById: null,
    paymentSubmittedAt: 1000, // receipt in flight
    paymentRejectionReason: null,
  };
}

// --- verifyPayment: the real atomic claim (mirror of admin/actions.ts) -------
function verifyPayment(o: Order, sideEffects: { verifyNotifies: number }): boolean {
  // atomic updateMany WHERE { id, AWAITING_VERIFICATION, PENDING_PAYMENT }
  if (o.paymentVerificationStatus === 'AWAITING_VERIFICATION' && o.status === 'PENDING_PAYMENT') {
    o.status = 'PAID';
    o.paidAt = 2000;
    o.paymentVerificationStatus = 'VERIFIED';
    o.paymentVerifiedAt = 2000;
    o.paymentVerifiedById = 'admin-A';
    o.paymentRejectionReason = null;
    sideEffects.verifyNotifies += 1; // count===1 -> fire once
    return true;
  }
  return false; // count===0 -> race, no side effects
}

// --- rejectPayment OLD: snapshot guard + UNCONDITIONAL update + side effects -
function rejectOld(o: Order, snapshot: Order, sideEffects: { rejectNotifies: number }) {
  // in-memory guard on the STALE snapshot (what the old code checked)
  if (snapshot.paymentVerificationStatus !== 'AWAITING_VERIFICATION') return;
  // unconditional update({ where:{ id } }) — does NOT touch status
  o.paymentVerificationStatus = 'REJECTED';
  o.paymentRejectionReason = 'blurry receipt';
  o.paymentSubmittedAt = null;
  o.paymentVerifiedAt = null;
  o.paymentVerifiedById = null;
  sideEffects.rejectNotifies += 1; // fires unconditionally
}

// --- rejectPayment NEW: conditional updateMany + count gate -------------------
function rejectNew(o: Order, snapshot: Order, sideEffects: { rejectNotifies: number }) {
  if (snapshot.paymentVerificationStatus !== 'AWAITING_VERIFICATION') return;
  // conditional claim: only matches if STILL awaiting + pending_payment
  const matches = o.paymentVerificationStatus === 'AWAITING_VERIFICATION' && o.status === 'PENDING_PAYMENT';
  if (!matches) return; // count!==1 -> early return, NO side effects
  o.paymentVerificationStatus = 'REJECTED';
  o.paymentRejectionReason = 'blurry receipt';
  o.paymentSubmittedAt = null;
  o.paymentVerifiedAt = null;
  o.paymentVerifiedById = null;
  sideEffects.rejectNotifies += 1; // gated on count===1
}

interface Row { path: string; scenario: string; detail: string; ok: boolean; }
const rows: Row[] = [];
function check(path: string, scenario: string, detail: string, ok: boolean) {
  rows.push({ path, scenario, detail, ok });
}

// ===== Scenario 1: concurrent verify + reject (verify lands first) ===========
// NEW: reject must no-op; order stays PAID + VERIFIED; no reject email.
{
  const o = freshOrder();
  const snap = { ...o }; // both requests snapshotted AWAITING_VERIFICATION
  const se = { verifyNotifies: 0, rejectNotifies: 0 };
  verifyPayment(o, se);        // admin A verifies -> PAID/VERIFIED
  rejectNew(o, snap, se);      // admin B's reject arrives on stale snapshot
  const clean = o.status === 'PAID' && o.paymentVerificationStatus === 'VERIFIED'
    && o.paymentVerifiedAt !== null && se.rejectNotifies === 0;
  check('NEW reject', 'verify-then-reject race', `status=${o.status} ver=${o.paymentVerificationStatus} rejectNotifies=${se.rejectNotifies}`, clean);
}
// OLD: reject overwrites -> PAID + REJECTED corruption + reject email sent.
{
  const o = freshOrder();
  const snap = { ...o };
  const se = { verifyNotifies: 0, rejectNotifies: 0 };
  verifyPayment(o, se);
  rejectOld(o, snap, se);
  const corrupt = o.status === 'PAID' && o.paymentVerificationStatus === 'REJECTED'
    && o.paymentVerifiedAt === null && se.rejectNotifies === 1;
  // "ok" here means the harness correctly REPRODUCES the documented defect
  check('OLD reject', 'verify-then-reject race', `status=${o.status} ver=${o.paymentVerificationStatus} rejectNotifies=${se.rejectNotifies} (defect repro: PAID+REJECTED)`, corrupt);
}

// ===== Scenario 2: double-click reject =======================================
// NEW: notifies exactly once.
{
  const o = freshOrder();
  const snap = { ...o };
  const se = { verifyNotifies: 0, rejectNotifies: 0 };
  rejectNew(o, snap, se); // first
  rejectNew(o, snap, se); // duplicate on same snapshot
  check('NEW reject', 'double-click reject', `rejectNotifies=${se.rejectNotifies} (expect 1)`, se.rejectNotifies === 1);
}
// OLD: notifies twice.
{
  const o = freshOrder();
  const snap = { ...o };
  const se = { verifyNotifies: 0, rejectNotifies: 0 };
  rejectOld(o, snap, se);
  rejectOld(o, snap, se);
  check('OLD reject', 'double-click reject', `rejectNotifies=${se.rejectNotifies} (defect repro: expect 2)`, se.rejectNotifies === 2);
}

// ===== Control: single reject on a clean awaiting order ======================
{
  const o = freshOrder();
  const snap = { ...o };
  const se = { verifyNotifies: 0, rejectNotifies: 0 };
  rejectNew(o, snap, se);
  const ok = o.paymentVerificationStatus === 'REJECTED' && o.paymentSubmittedAt === null
    && o.status === 'PENDING_PAYMENT' && se.rejectNotifies === 1;
  check('NEW reject', 'single reject (control)', `ver=${o.paymentVerificationStatus} submittedAt=${o.paymentSubmittedAt} notifies=${se.rejectNotifies}`, ok);
}

console.log('reject-payment atomicity matrix (BUG-037 / invariant F15)');
console.log('-'.repeat(72));
let failures = 0;
for (const r of rows) {
  if (!r.ok) failures++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.path.padEnd(11)} ${r.scenario.padEnd(26)} ${r.detail}`);
}
console.log('-'.repeat(72));
if (failures === 0) {
  console.log('RESULT: NEW reject is atomic+idempotent (loses to verify, fires once); OLD reject corrupted PAID->REJECTED and double-notified (defect reproduced)');
  process.exit(0);
} else {
  console.log(`RESULT: ${failures} assertion(s) FAILED`);
  process.exit(1);
}
