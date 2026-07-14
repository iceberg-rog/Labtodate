/**
 * BUG-038 offline regression matrix — confirmDelivery atomicity.
 *
 * Models the SHIPPED->DELIVERED buyer confirmation against two implementations:
 *   OLD: snapshot guard (status==='SHIPPED') then UNCONDITIONAL
 *        order.update({ where:{id} }) + admin-notify + audit.
 *   NEW: conditional order.updateMany({ where:{id, status:'SHIPPED'} }) and
 *        every side effect gated on count===1.
 *
 * Two races are exercised:
 *   1. Buyer double-click: two confirmDelivery calls snapshot before either
 *      write lands.
 *   2. Concurrent admin refundOrder: refund claims the row (any non-REFUNDED,
 *      incl. SHIPPED) -> REFUNDED + restock + email; buyer confirm runs after
 *      having snapshotted SHIPPED.
 *
 * Asserts NEW never regresses a REFUNDED row to DELIVERED and notifies admins
 * exactly once; documents OLD corrupting REFUNDED->DELIVERED and double-notifying.
 *
 * Run: node --experimental-strip-types scripts/verify-confirm-delivery-atomic.ts
 */
export {};

type Status = 'SHIPPED' | 'DELIVERED' | 'REFUNDED' | 'CANCELED';

interface Order {
  id: string;
  status: Status;
  deliveredAt: number | null;
}

interface World {
  order: Order;
  adminNotifies: number;
  refundEmails: number;
  stockReturned: number;
}

function freshWorld(): World {
  return { order: { id: 'o1', status: 'SHIPPED', deliveredAt: null }, adminNotifies: 0, refundEmails: 0, stockReturned: 0 };
}

// ----- OLD confirmDelivery: snapshot guard, then unconditional update -----
function oldConfirm(w: World, snapshotStatus: Status) {
  if (snapshotStatus !== 'SHIPPED') {
    if (snapshotStatus === 'DELIVERED') return;
    throw new Error('cannot confirm');
  }
  // unconditional write — overwrites whatever the row is now
  w.order.status = 'DELIVERED';
  w.order.deliveredAt = Date.now();
  w.adminNotifies += 1;
}

// ----- NEW confirmDelivery: conditional updateMany + count gate -----
function newConfirm(w: World, snapshotStatus: Status) {
  if (snapshotStatus !== 'SHIPPED') {
    if (snapshotStatus === 'DELIVERED') return;
    throw new Error('cannot confirm');
  }
  // conditional write: only lands if STILL shipped
  let count = 0;
  if (w.order.status === 'SHIPPED') {
    w.order.status = 'DELIVERED';
    w.order.deliveredAt = Date.now();
    count = 1;
  }
  if (count !== 1) return; // lost race — no side effects
  w.adminNotifies += 1;
}

// admin refundOrder: atomic claim of any non-REFUNDED row + restock + email
function refund(w: World) {
  if (w.order.status === 'REFUNDED') return;
  w.order.status = 'REFUNDED';
  w.stockReturned += 1;
  w.refundEmails += 1;
}

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

// === Race 1: buyer double-click (both snapshot SHIPPED before either write) ===
{
  // OLD: both pass guard, both write+notify -> 2 admin notifies (defect)
  const wo = freshWorld();
  oldConfirm(wo, 'SHIPPED');
  oldConfirm(wo, 'SHIPPED');
  check('OLD double-click double-notifies (documents defect)', wo.adminNotifies === 2);

  // NEW: first lands (count 1), second sees row already DELIVERED (count 0) -> 1 notify
  const wn = freshWorld();
  newConfirm(wn, 'SHIPPED');
  newConfirm(wn, 'SHIPPED');
  check('NEW double-click notifies exactly once', wn.adminNotifies === 1);
  check('NEW ends DELIVERED', wn.order.status === 'DELIVERED');
}

// === Race 2: concurrent admin refund vs buyer confirm ===
// Both read SHIPPED; refund commits first, then buyer confirm write lands.
{
  // OLD: buyer's unconditional write overwrites REFUNDED back to DELIVERED (corruption)
  const wo = freshWorld();
  const buyerSnapshot: Status = wo.order.status; // 'SHIPPED'
  refund(wo); // admin commits -> REFUNDED, stock returned, email sent
  oldConfirm(wo, buyerSnapshot); // buyer write lands unconditionally
  check('OLD regresses REFUNDED->DELIVERED (documents corruption)', wo.order.status === 'DELIVERED');
  check('OLD: stock already returned + refund emailed while row shows DELIVERED', wo.stockReturned === 1 && wo.refundEmails === 1);

  // NEW: buyer's conditional write sees row is REFUNDED (not SHIPPED) -> count 0, no-op
  const wn = freshWorld();
  const snap2: Status = wn.order.status;
  refund(wn);
  newConfirm(wn, snap2);
  check('NEW preserves REFUNDED (no regression)', wn.order.status === 'REFUNDED');
  check('NEW fires no admin delivery-notify on the refunded row', wn.adminNotifies === 0);
}

// === Sanity: NEW happy path still delivers + notifies once ===
{
  const wn = freshWorld();
  newConfirm(wn, 'SHIPPED');
  check('NEW happy path: DELIVERED + 1 notify', wn.order.status === 'DELIVERED' && wn.adminNotifies === 1 && wn.order.deliveredAt !== null);
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
