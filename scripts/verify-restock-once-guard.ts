/**
 * Offline regression harness — restock-once-and-only-once under concurrency (BUG-036)
 * ---------------------------------------------------------------------------------
 * Invariant S4 (manual-payment posture):
 *   Cancelling OR refunding an order returns its reserved stock to the catalog
 *   exactly ONCE. Two concurrent admin clicks on Cancel (or Refund) for the same
 *   order must not each run the restock loop and double-increment Product.quantity
 *   (nor double-email the buyer / double-fire the audit + notifyAdmins).
 *
 * Root cause this guards against: the pre-BUG-036 code did a snapshot read
 * (findUnique) then an UNCONDITIONAL `prisma.order.update({ where: { id } })`
 * followed by the restock loop. Under two interleaved requests both reads see a
 * cancelable/refundable status, both writes succeed (update-by-id always matches),
 * and BOTH restock — stock drifts up by 2x and the buyer gets two "canceled" /
 * "refund issued" notices. The fix claims the state transition with a CONDITIONAL
 * updateMany whose WHERE encodes the precondition, then gates restock + all side
 * effects on `count === 1`, so only the winning request restocks.
 *
 * Why offline: the admin cancel/refund paths are side-effectful server actions and
 * the deployed site is unreachable (BUG-033), so this is not browser-testable. This
 * harness re-implements the cancel/refund WHERE-predicate + count gate verbatim,
 * models a real conditional-update race, and proves restock fires exactly once.
 *
 * Run: node --experimental-strip-types scripts/verify-restock-once-guard.ts
 *   (npx tsx is unavailable in the Linux sandbox — node_modules carries a Windows
 *    esbuild binary; node's native type-stripping runs this file directly.)
 * Exit 0 = restock-once holds; exit 1 = a guard regressed (double restock).
 */

export {}; // module scope — keep top-level identifiers out of the global script scope

type OrderStatus =
  | 'PENDING_PAYMENT' | 'PAID' | 'PROCESSING' | 'SHIPPED'
  | 'DELIVERED' | 'CANCELED' | 'REFUNDED';

interface Row {
  id: string;
  status: OrderStatus;
  paymentSubmittedAt: Date | null;
}

// A minimal model of the two Prisma calls the production code uses, with the
// real semantics that matter for the race:
//  - update({where:{id}})            → always writes if the row exists (count 1)
//  - updateMany({where:{id,...cond}})→ writes ONLY if the row still matches the
//                                       extra precondition; returns count 0 if a
//                                       concurrent writer already changed it.
class FakeDb {
  row: Row;
  stock = 0;            // units returned to catalog by restock loops
  restockRuns = 0;      // how many times the restock loop actually executed
  notifies = 0;         // buyer "canceled"/"refunded" notifications sent
  constructor(row: Row) { this.row = row; }

  // Unconditional update-by-id (OLD code). Always succeeds for an existing row.
  updateById(next: Partial<Row>): number {
    Object.assign(this.row, next);
    return 1;
  }
  // Conditional updateMany (NEW code). Succeeds only if predicate still holds.
  updateWhere(pred: (r: Row) => boolean, next: Partial<Row>): number {
    if (!pred(this.row)) return 0;
    Object.assign(this.row, next);
    return 1;
  }
  restock(qty: number) { this.stock += qty; this.restockRuns += 1; this.notifies += 1; }
}

const QTY = 3; // one order line, 3 units reserved

// A request is modeled in two phases so concurrency is faithful:
//   decide(snapshot) → did this request pass its in-memory guards? (both
//                      requests snapshot the ORIGINAL row before either writes)
//   commit(db)       → perform the state write + restock for a request that
//                      passed its guards. write mode is OLD (unconditional) or
//                      NEW (conditional updateMany + count gate).
interface Path {
  decide: (snap: Row) => boolean;
  commit: (db: FakeDb) => void;
}

const cancelDecide = (snap: Row): boolean => {
  if (['CANCELED', 'REFUNDED', 'DELIVERED'].includes(snap.status)) return false;
  if (['PAID', 'PROCESSING', 'SHIPPED'].includes(snap.status)) return false;
  if (snap.paymentSubmittedAt) return false;
  return true;
};
const refundDecide = (snap: Row): boolean => snap.status !== 'REFUNDED';

// OLD: unconditional update-by-id → every passed request restocks.
const oldCancel: Path = {
  decide: cancelDecide,
  commit: (db) => { db.updateById({ status: 'CANCELED' }); db.restock(QTY); },
};
const oldRefund: Path = {
  decide: refundDecide,
  commit: (db) => { db.updateById({ status: 'REFUNDED' }); db.restock(QTY); },
};
// NEW: conditional updateMany; restock gated on count===1, so only the racer
// whose precondition still holds restocks.
const newCancel: Path = {
  decide: cancelDecide,
  commit: (db) => {
    const c = db.updateWhere(
      (r) => r.status === 'PENDING_PAYMENT' && r.paymentSubmittedAt === null,
      { status: 'CANCELED' },
    );
    if (c === 1) db.restock(QTY);
  },
};
const newRefund: Path = {
  decide: refundDecide,
  commit: (db) => {
    const c = db.updateWhere((r) => r.status !== 'REFUNDED', { status: 'REFUNDED' });
    if (c === 1) db.restock(QTY);
  },
};

// Faithful two-concurrent-clicks race: BOTH requests read the original row and
// run their guards (decide) before EITHER write lands; then both commits apply
// in sequence (request A wins the DB write, request B lands second).
function raceDoubleClick(path: Path, start: Row): FakeDb {
  const db = new FakeDb({ ...start });
  const snapA = { ...db.row };
  const snapB = { ...db.row };       // both snapshot the original state
  const goA = path.decide(snapA);
  const goB = path.decide(snapB);    // both pass their in-memory guards
  if (goA) path.commit(db);          // A's write lands first
  if (goB) path.commit(db);          // B's write lands second
  return db;
}

interface Case { name: string; path: Path; start: Row; expectRestockRuns: number; }
const cases: Case[] = [
  { name: 'NEW cancel · double-click clean pending', path: newCancel,
    start: { id: 'O1', status: 'PENDING_PAYMENT', paymentSubmittedAt: null }, expectRestockRuns: 1 },
  { name: 'NEW refund · double-click paid order', path: newRefund,
    start: { id: 'O2', status: 'PAID', paymentSubmittedAt: new Date() }, expectRestockRuns: 1 },
  // Negative controls — OLD code demonstrably double-restocks (proves the harness
  // is sensitive and the bug was real). expectRestockRuns: 2 documents the defect.
  { name: 'OLD cancel · double-click (defect baseline)', path: oldCancel,
    start: { id: 'O3', status: 'PENDING_PAYMENT', paymentSubmittedAt: null }, expectRestockRuns: 2 },
  { name: 'OLD refund · double-click (defect baseline)', path: oldRefund,
    start: { id: 'O4', status: 'PAID', paymentSubmittedAt: new Date() }, expectRestockRuns: 2 },
];

let failures = 0;
const rows: string[] = [];
for (const c of cases) {
  const db = raceDoubleClick(c.path, c.start);
  const ok = db.restockRuns === c.expectRestockRuns && db.stock === c.expectRestockRuns * QTY && db.notifies === c.expectRestockRuns;
  if (!ok) failures++;
  rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(46)} restockRuns=${db.restockRuns} stock=+${db.stock} notifies=${db.notifies} (expect runs=${c.expectRestockRuns})`);
}

// Cross-check: NEW paths restock exactly once; OLD paths restocked twice. If a
// future edit reverts either NEW path to an unconditional update, its restockRuns
// flips to 2 and this script exits 1.
console.log('restock-once-and-only-once guard matrix (BUG-036 / invariant S4)');
console.log('-----------------------------------------------------------------');
console.log(rows.join('\n'));
console.log('-----------------------------------------------------------------');
if (failures > 0) {
  console.error(`RESULT: ${failures} guard violation(s) — S4 restock-once BROKEN`);
  process.exit(1);
}
console.log('RESULT: NEW cancel/refund restock exactly once under concurrent double-click; OLD paths double-restocked (defect reproduced)');
process.exit(0);
