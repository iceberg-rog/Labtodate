/**
 * Source-contract guard — checkout reservation/order/handoff atomicity wiring.
 * ----------------------------------------------------------------------------
 * The BEHAVIOURAL proofs run against a real DB in scripts/it-order-atomicity.ts
 * (forced create-failure rollback with cart intact, partial-reservation rollback,
 * REAL orderNumber P2002 whole-tx retry, concurrent last-unit race, buyability +
 * financial guards, exact cart-snapshot clear, and the full Stripe handoff saga).
 * This supplemental guard keeps the callers COUPLED to the shared helpers so they
 * can't silently regress to the old non-atomic shapes.
 *
 * Asserts:
 *  - reserveAndCreateOrder wraps a $transaction in a P2002 retry loop, guards the
 *    decrement on status/mode/priceCents/currency, and clears the cart with a
 *    GUARDED per-row snapshot delete (id + userId + quantity) that count-checks
 *    (CartChangedError) — never a bare user-wide deleteMany;
 *  - single (orders/actions.ts) and cart (cart/actions.ts) pass expectedPriceCents
 *    + expectedCurrency and route through reserveAndCreateOrder;
 *  - cart passes an exact cartClear snapshot (no bare cartItem.deleteMany), and
 *    orders the whole cart (no subset filter);
 *  - both callers hand off through the SHARED Stripe saga (stripeCheckoutHandoff)
 *    and keep NO inline Stripe cleanup (no releaseReservedStock / direct
 *    cancelAndRestockOrder / inline session.expire).
 *
 * Run: npx tsx scripts/verify-checkout-stock-rollback.ts
 */
import { readFileSync } from 'node:fs';
import { reserveAndCreateOrder } from '../src/lib/orders/checkout-tx';
import { stripeCheckoutHandoff } from '../src/lib/orders/stripe-handoff';

let pass = 0; let fail = 0; const rows: string[] = [];
const chk = (n: string, ok: boolean, d = '') => { rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); ok ? pass++ : fail++; };
const src = (p: string) => readFileSync(p, 'utf8');

chk('helpers exported', typeof reserveAndCreateOrder === 'function' && typeof stripeCheckoutHandoff === 'function');

const helper = src('src/lib/orders/checkout-tx.ts');
chk('reserve wraps $transaction in P2002 retry loop',
  /for \(let attempt/.test(helper) && /\$transaction/.test(helper) && /P2002/.test(helper) && /InsufficientStockError/.test(helper));
chk('reserve decrement is guarded on status/mode/priceCents/currency',
  /status: 'PUBLISHED'/.test(helper) && /mode: \{ not: 'QUOTE_ONLY' \}/.test(helper) &&
  /priceCents: r\.expectedPriceCents/.test(helper) && /currency: r\.expectedCurrency/.test(helper));
chk('cart clear is an exact GUARDED snapshot delete (id+userId+quantity) with count-check',
  /cartClear/.test(helper) &&
  /cartItem\.deleteMany\(\s*\{\s*\n?\s*where:\s*\{ id: ci\.id, userId: cartClear\.userId, quantity: ci\.quantity \}/.test(helper) &&
  /CartChangedError/.test(helper) &&
  !/cartItem\.deleteMany\(\s*\{\s*where:\s*\{\s*userId:[^,}]*\}\s*\}\s*\)/.test(helper));

const single = src('src/lib/orders/actions.ts');
const cart = src('src/lib/cart/actions.ts');
for (const [role, s] of [['single', single], ['cart', cart]] as const) {
  chk(`${role} routes through reserveAndCreateOrder with expected financials`,
    /reserveAndCreateOrder\s*\(/.test(s) && /expectedPriceCents/.test(s) && /expectedCurrency/.test(s) && !/releaseReservedStock/.test(s));
  // Cleanup is delegated to the saga: the caller calls stripeCheckoutHandoff and
  // never calls cancelAndRestockOrder directly. (sessions.expire legitimately
  // appears inside the injected api adapter, which the saga drives.)
  chk(`${role} hands off through the shared stripeCheckoutHandoff saga (cleanup delegated)`,
    /stripeCheckoutHandoff\s*\(/.test(s) && !/cancelAndRestockOrder\s*\(/.test(s));
  // Session persistence is a single-winner CAS (status PENDING + null-or-own sid),
  // returning the row count — never a bare unconditional order.update(stripeSessionId).
  chk(`${role} persists stripeSessionId via a CAS (status + OR null/own), returns count`,
    /updateMany\(\{[\s\S]*?status: 'PENDING_PAYMENT'[\s\S]*?stripeSessionId: null[\s\S]*?stripeSessionId: sid[\s\S]*?\}\)/.test(s) &&
    /return r\.count/.test(s) && !/order\.update\(\{ where: \{ id: order\.id \}, data: \{ stripeSessionId/.test(s));
}

chk('cart uses exact cartClear snapshot, not a bare user-wide delete',
  /cartClear:\s*\{\s*userId:.*items:/.test(cart) && !/clearCartUserId/.test(cart) &&
  !/cartItem\.deleteMany\(\s*\{\s*where:\s*\{\s*userId:\s*session/.test(cart));
chk('cart orders the WHOLE cart (no subset filter → no silent partial order)',
  !/const valid = items\.filter/.test(cart) && /items\.every\(buyable\)/.test(cart));

console.log('checkout atomicity wiring guard');
console.log('----------------------------------------------------------------');
console.log(rows.join('\n'));
console.log('----------------------------------------------------------------');
if (fail > 0) { console.error(`RESULT: ${fail} wiring violation(s)`); process.exit(1); }
console.log('RESULT: single + cart route through reserveAndCreateOrder (guarded financials + exact cart snapshot) and the shared Stripe saga; behaviour proven in it-order-atomicity.ts');
process.exit(0);
