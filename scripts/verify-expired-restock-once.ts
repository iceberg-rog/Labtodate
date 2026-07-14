/**
 * Source-contract guard — Stripe-aware cancellation saga wiring.
 * ----------------------------------------------------------------------------
 * BEHAVIOUR proven against a real DB in scripts/it-order-atomicity.ts (cancel +
 * restock in one tx, forced restock-failure rollback + retry, session expired
 * before cancel, expire-failure leaves stock reserved, stale-event / proof / CAS
 * no-ops, CAS-lost handoff). This guard keeps every cancellation path COUPLED to
 * the shared saga so none can regress to a non-atomic / non-Stripe-aware shape.
 *
 * Asserts:
 *  - cancelAndRestockOrder claims + restocks in ONE $transaction and CAS-matches
 *    the expected stripeSessionId; cancelOrderSaga expires the attached session
 *    BEFORE cancelling and treats expire failure as 'expire-failed';
 *  - the expired webhook routes through cancelOrderSaga with onlyIfSessionIs =
 *    the event's session id (no inline claim/restock);
 *  - the completed webhook does NOT silently ack a captured payment on a TERMINAL
 *    order — it runs the late-payment anomaly (idempotent refund / critical alert);
 *  - admin single cancel AND bulk cancel route through cancelOrderSaga (no inline
 *    claim + separate restock loop; bulk restocks/notifies only actual winners);
 *  - the orphan sweep enforces a hard TTL floor above Stripe's session lifetime.
 *
 * Run: npx tsx scripts/verify-expired-restock-once.ts
 */
import { readFileSync } from 'node:fs';
import { cancelOrderSaga } from '../src/lib/orders/stripe-handoff';
import { orphanSweepTtlMinutes } from '../src/lib/orders/orphan-ttl';

let pass = 0; let fail = 0; const rows: string[] = [];
const chk = (n: string, ok: boolean, d = '') => { rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); ok ? pass++ : fail++; };
const src = (p: string) => readFileSync(p, 'utf8');

chk('cancelOrderSaga is exported', typeof cancelOrderSaga === 'function');

const tx = src('src/lib/orders/checkout-tx.ts');
chk('cancelAndRestockOrder claims + restocks in ONE tx with a session CAS',
  /export async function cancelAndRestockOrder/.test(tx) && /return db\.\$transaction/.test(tx) &&
  /'expectedStripeSessionId' in opts/.test(tx) && /where\.stripeSessionId = opts\.expectedStripeSessionId/.test(tx) &&
  /increment: it\.quantity/.test(tx));

const saga = src('src/lib/orders/stripe-handoff.ts');
chk('cancelOrderSaga expires the attached session BEFORE cancel (expire-failed on failure)',
  /export async function cancelOrderSaga/.test(saga) && /boundedExpire\(api, snap\.stripeSessionId\)/.test(saga) &&
  /return 'expire-failed'/.test(saga) && /onlyIfSessionIs/.test(saga));

const webhook = src('src/app/api/stripe/webhook/route.ts');
const expIdx = webhook.indexOf("'checkout.session.expired'");
const expiredBranch = expIdx >= 0 ? webhook.slice(expIdx) : webhook;
chk('expired webhook → cancelOrderSaga with onlyIfSessionIs=event session (no inline claim/restock)',
  /cancelOrderSaga\s*\(/.test(expiredBranch) && /onlyIfSessionIs: session\.id/.test(expiredBranch) &&
  !/quantity:\s*\{\s*increment/.test(expiredBranch) && !/order\.updateMany/.test(expiredBranch));
chk('completed webhook does NOT silently ack captured money on a TERMINAL order',
  /handleLatePaymentAnomaly\s*\(/.test(webhook) &&
  /current\.status === 'CANCELED' \|\| current\.status === 'REFUNDED'/.test(webhook) &&
  /refunds\.create/.test(webhook) && /idempotencyKey/.test(webhook));

const admin = src('src/app/admin/actions.ts');
chk('admin single cancel → cancelOrderSaga; bulk → cancelOrdersBatch; no old inline claim; winners from batch',
  /cancelOrderSaga\s*\(/.test(admin) && /cancelOrdersBatch\s*\(/.test(admin) &&
  !/const claim = await prisma\.order\.updateMany\([\s\S]*?status: 'PENDING_PAYMENT', paymentSubmittedAt: null \}/.test(admin) &&
  /winners = orders\.filter\(\(o\) => canceled\.includes/.test(admin));

const sweep = src('src/app/api/cron/sla-sweep/route.ts');
chk('orphan sweep uses the fail-safe orphanSweepTtlMinutes floor helper',
  /orphanSweepTtlMinutes\(process\.env\.ORPHAN_ORDER_TTL_MINUTES\)/.test(sweep) && /stripeSessionId: null/.test(sweep));
// BEHAVIOURAL: fail-safe TTL — floor wins, invalid falls back to default, never NaN
chk('orphanSweepTtlMinutes · floor/default/invalid (never NaN)',
  orphanSweepTtlMinutes('10') === 1500 && orphanSweepTtlMinutes('99999') === 99999 &&
  orphanSweepTtlMinutes(undefined) === 10080 && orphanSweepTtlMinutes('abc') === 10080 &&
  orphanSweepTtlMinutes('-5') === 10080 && orphanSweepTtlMinutes('0') === 10080 &&
  Number.isFinite(orphanSweepTtlMinutes('NaN')));

// Safe expire everywhere: cancellation/handoff paths must NOT classify expire
// errors by message; they go through session-api (retrieve status==='expired').
const sessionApi = src('src/lib/stripe/session-api.ts');
chk('safeExpire confirms via retrieve(status==="expired"), fails closed (no message regex)',
  /s\.status === 'expired'/.test(sessionApi) && /throw err/.test(sessionApi));
for (const [name, f] of [['admin', 'src/app/admin/actions.ts'], ['single', 'src/lib/orders/actions.ts'], ['cart', 'src/lib/cart/actions.ts'], ['webhook', 'src/app/api/stripe/webhook/route.ts']] as const) {
  const s = src(f);
  chk(`${name} does not classify Stripe expire errors by message regex`, !/expire\|expired\|no such\|already/.test(s));
}

// Webhook payment-capture races
chk('completed webhook requires payment_status==="paid" (synchronous card-only)',
  /payment_status !== 'paid'/.test(webhook) && /payment_method_types: \['card'\]/.test(src('src/lib/orders/actions.ts')) && /payment_method_types: \['card'\]/.test(src('src/lib/cart/actions.ts')));
chk('PAID flip is CAS on this session id (no foreign/stale session marks PAID)',
  /status: 'PENDING_PAYMENT', stripeSessionId: session\.id/.test(webhook));
chk('update-loss re-reads terminal/foreign-session state and routes to the anomaly',
  /updateRes\.count !== 1/.test(webhook) && /after\.stripeSessionId !== session\.id/.test(webhook) && /handleLatePaymentAnomaly/.test(webhook));

// Exactly-once anomaly via durable ledger + REFUNDED-same-PI classification
chk('late-payment anomaly is exactly-once via the WebhookEvent ledger (claim + delete-on-fail)',
  /webhookEvent\.create\(\{ data: \{ id: eventId/.test(webhook) && /e\.code === 'P2002'/.test(webhook) && /webhookEvent\.delete/.test(webhook));
chk('normal REFUNDED-same-PI replay is NOT a false late refund/critical',
  /status === 'REFUNDED' && pi && order\.stripePaymentIntentId === pi/.test(webhook) && /'refund-replay'/.test(webhook));

chk('admin bulk cancel uses the DI batch transition + surfaces failures',
  /cancelOrdersBatch\s*\(/.test(admin) && /expireFailed/.test(admin) && /left reserved/.test(admin));

console.log('cancellation saga wiring guard');
console.log('----------------------------------------------------------------');
console.log(rows.join('\n'));
console.log('----------------------------------------------------------------');
if (fail > 0) { console.error(`RESULT: ${fail} wiring violation(s)`); process.exit(1); }
console.log('RESULT: expired webhook + admin single/bulk cancel route through the Stripe-aware cancelOrderSaga; terminal captured payments hit the anomaly path; orphan sweep floored; behaviour proven in it-order-atomicity.ts');
process.exit(0);
