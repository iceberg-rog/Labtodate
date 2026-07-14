/**
 * Offline regression matrix for BUG-043 — refundOrder must only run on
 * money-captured statuses.
 *
 * Models the refundOrder status precondition OLD (`status != 'REFUNDED'`) vs
 * NEW (`status in ['PAID','PROCESSING','SHIPPED','DELIVERED']`) against a tiny
 * in-memory order+stock store, and asserts the NEW guard:
 *   - refunds a captured order exactly once (restock +1, status REFUNDED, email),
 *   - is idempotent on an already-REFUNDED order (no second restock),
 *   - NO-OPS on a CANCELED order (OLD double-restocks -> phantom inventory),
 *   - NO-OPS on a PENDING_PAYMENT order (OLD restocks + mis-emails a "refund").
 *
 * Pure logic, no DB. Run:
 *   node --experimental-strip-types scripts/verify-refund-status-guard.ts
 */

type Status =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELED'
  | 'REFUNDED';

// Scope this file as a module (export {}) so its top-level `Status` / `Order`
// declarations stay file-local instead of merging into the shared global
// scope with the other verify-*.ts matrices (BUG-044 build-hygiene: this was
// the lone non-module matrix; a sibling matrix's global `Order`/`OrderStatus`
// collided with it under the project tsconfig).
export {};

interface Order { status: Status; qty: number; refundEmails: number; }

const REFUNDABLE: Status[] = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

/** OLD guard: only blocked re-refunding an already-REFUNDED row.
 *  Modelled as the write's WHERE `status != 'REFUNDED'` — matches everything
 *  except an already-refunded row (captured OR not). */
function refundOLD(o: Order): void {
  const s: Status = o.status; // capture before any narrowing
  const flipMatches = s !== 'REFUNDED';
  if (!flipMatches) return;
  o.status = 'REFUNDED';
  o.qty += 1;            // restock
  o.refundEmails += 1;   // "refund to your original payment method"
}

/** NEW guard: positive money-captured allow-list, re-encoded in the write. */
function refundNEW(o: Order): void {
  const s: Status = o.status;
  const flipMatches = REFUNDABLE.includes(s); // snapshot guard == atomic WHERE
  if (!flipMatches) return;
  o.status = 'REFUNDED';
  o.qty += 1;
  o.refundEmails += 1;
}

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  x ${name}`); }
  else console.log(`  ok ${name}`);
}

function mk(status: Status): Order { return { status, qty: 0, refundEmails: 0 }; }

// --- Case 1: PAID order — both refund exactly once ---
{
  const oldO = mk('PAID'); refundOLD(oldO);
  const newO = mk('PAID'); refundNEW(newO);
  check('PAID -> NEW refunds once (status REFUNDED, +1 stock, 1 email)',
    newO.status === 'REFUNDED' && newO.qty === 1 && newO.refundEmails === 1);
  check('PAID -> OLD and NEW behave identically on the happy path',
    oldO.status === newO.status && oldO.qty === newO.qty && oldO.refundEmails === newO.refundEmails);
}

// --- Case 2: already-REFUNDED — idempotent under NEW ---
{
  const newO = mk('REFUNDED'); refundNEW(newO);
  check('REFUNDED -> NEW no-ops (no double restock, no email)',
    newO.qty === 0 && newO.refundEmails === 0);
}

// --- Case 3: CANCELED — the phantom-inventory bug ---
{
  const oldO = mk('CANCELED'); refundOLD(oldO);
  const newO = mk('CANCELED'); refundNEW(newO);
  check('CANCELED -> OLD double-restocks (phantom inventory) — documents the bug',
    oldO.status === 'REFUNDED' && oldO.qty === 1);
  check('CANCELED -> NEW no-ops (no restock, stays CANCELED, no email)',
    newO.status === 'CANCELED' && newO.qty === 0 && newO.refundEmails === 0);
}

// --- Case 4: PENDING_PAYMENT — no money captured ---
{
  const oldO = mk('PENDING_PAYMENT'); refundOLD(oldO);
  const newO = mk('PENDING_PAYMENT'); refundNEW(newO);
  check('PENDING_PAYMENT -> OLD wrongly refunds + emails — documents the bug',
    oldO.status === 'REFUNDED' && oldO.refundEmails === 1);
  check('PENDING_PAYMENT -> NEW no-ops (no false "refund" email, stays pending)',
    newO.status === 'PENDING_PAYMENT' && newO.qty === 0 && newO.refundEmails === 0);
}

// --- Case 5: every fulfilment state remains refundable under NEW ---
{
  for (const s of ['PROCESSING', 'SHIPPED', 'DELIVERED'] as Status[]) {
    const o = mk(s); refundNEW(o);
    check(`${s} -> NEW refunds once`, o.status === 'REFUNDED' && o.qty === 1);
  }
}

if (failures > 0) {
  console.error(`\nverify-refund-status-guard: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nverify-refund-status-guard: all assertions passed');
