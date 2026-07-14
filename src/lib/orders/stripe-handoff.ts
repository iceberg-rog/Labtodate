import { type PrismaClient } from '@prisma/client';
import { cancelAndRestockOrder } from './checkout-tx';

/**
 * Stripe-aware order-cancellation + checkout hand-off sagas, shared by the single
 * and cart checkout paths, the expired webhook, and admin cancel (single + bulk),
 * so failure handling cannot diverge. Dependency-injected (Stripe session API +
 * db + persist callback) → driven directly by the disposable-DB / fake-Stripe
 * integration tests.
 *
 * Money/stock invariant: an active payable Stripe session must NEVER be left
 * pointing at a canceled/restocked order, and a confirmed failure must NEVER
 * silently strand reserved stock. Every cancel expires the attached session FIRST
 * (confirmed), then claims PENDING_PAYMENT with a CAS on the SAME session id (and
 * no proof), so a concurrent persist / a superseded session / a proof upload each
 * leave the cancel a no-op instead of minting stock or capturing orphaned money.
 */

export interface StripeSessionApi {
  /** Must be IDEMPOTENT: expiring an already-expired session resolves ok. */
  create(): Promise<{ id: string; url: string | null }>;
  expire(id: string): Promise<void>;
}

async function boundedExpire(api: StripeSessionApi, sessionId: string, retries = 3): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try { await api.expire(sessionId); return true; } catch { /* transient — retry */ }
  }
  return false;
}

export type CancelOutcome = 'canceled' | 'noop' | 'expire-failed';

/**
 * Stripe-aware atomic cancel. Reads the snapshot, expires the attached session
 * FIRST, then CAS-cancels + restocks on that exact session id (and no proof if
 * required), all so a concurrent writer can't race it.
 *   noop           — not PENDING_PAYMENT / proof in flight / session ≠ onlyIfSessionIs / CAS lost
 *   expire-failed  — an active session could not be confirmed expired → do NOT cancel/restock
 */
export async function cancelOrderSaga(
  db: PrismaClient,
  api: StripeSessionApi | null,
  orderId: string,
  opts: { onlyIfSessionIs?: string; requireNoProof?: boolean } = {},
): Promise<CancelOutcome> {
  const snap = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, stripeSessionId: true, paymentSubmittedAt: true },
  });
  if (!snap || snap.status !== 'PENDING_PAYMENT') return 'noop';
  if (opts.requireNoProof && snap.paymentSubmittedAt) return 'noop';
  // Webhook passes the event's session id so an OLD expired event can't cancel an
  // order that has since moved to a different/new session.
  if (opts.onlyIfSessionIs !== undefined && snap.stripeSessionId !== opts.onlyIfSessionIs) return 'noop';
  if (snap.stripeSessionId) {
    if (!api || !(await boundedExpire(api, snap.stripeSessionId))) return 'expire-failed';
  }
  return cancelAndRestockOrder(db, orderId, {
    requireNoProof: opts.requireNoProof,
    expectedStripeSessionId: snap.stripeSessionId,
  });
}

/**
 * Batch cancel used by admin bulk-cancel. Runs each candidate through the
 * Stripe-aware cancelOrderSaga and partitions the results, so the caller restocks/
 * notifies/counts ONLY actual `canceled` winners and can SURFACE expire/DB failures
 * (never silently drops them). DI-testable against a real DB + fake Stripe.
 */
export async function cancelOrdersBatch(
  db: PrismaClient,
  api: StripeSessionApi | null,
  orderIds: readonly string[],
  opts: { requireNoProof?: boolean } = {},
): Promise<{ canceled: string[]; expireFailed: string[]; errored: string[] }> {
  const canceled: string[] = [];
  const expireFailed: string[] = [];
  const errored: string[] = [];
  for (const id of orderIds) {
    try {
      const out = await cancelOrderSaga(db, api, id, opts);
      if (out === 'canceled') canceled.push(id);
      else if (out === 'expire-failed') expireFailed.push(id);
      // 'noop' → proof-in-flight / paid / stale / raced — correctly skipped, not an error
    } catch {
      errored.push(id);
    }
  }
  return { canceled, expireFailed, errored };
}

/** Bounded, snapshot-aware cleanup for paths where NO session was created (Stripe
 *  absent / create() threw) — cancelOrderSaga sees a null session and just cancels. */
async function boundedCleanup(db: PrismaClient, api: StripeSessionApi | null, orderId: string, retries = 3): Promise<CancelOutcome> {
  let last: CancelOutcome = 'expire-failed';
  for (let i = 0; i < retries; i++) {
    try {
      last = await cancelOrderSaga(db, api, orderId);
      if (last !== 'expire-failed') return last;
    } catch { /* transient DB error — retry */ }
  }
  return last;
}

/** Bounded cancel+restock CAS after the hand-off already confirmed-expired the
 *  session `ownSid` it created (so we never double-expire). Cancels ONLY while the
 *  order's current session is null OR exactly `ownSid`; a DIFFERENT session id
 *  (another concurrent writer attached session B) is left untouched — we must
 *  never cancel/restock an order behind a live session we did not expire. */
async function boundedCancelOwn(db: PrismaClient, orderId: string, ownSid: string, retries = 3): Promise<'canceled' | 'noop' | 'failed'> {
  for (let i = 0; i < retries; i++) {
    try {
      const snap = await db.order.findUnique({ where: { id: orderId }, select: { status: true, stripeSessionId: true } });
      if (!snap || snap.status !== 'PENDING_PAYMENT') return 'noop';
      if (snap.stripeSessionId !== null && snap.stripeSessionId !== ownSid) return 'noop'; // foreign live session — leave reserved
      const out = await cancelAndRestockOrder(db, orderId, { expectedStripeSessionId: snap.stripeSessionId });
      return out === 'canceled' ? 'canceled' : 'noop';
    } catch { /* transient — retry */ }
  }
  return 'failed';
}

export type StripeHandoffResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'no-session' | 'session-orphaned' | 'cleanup-failed' | 'cas-lost'; sessionId: string | null };

/**
 * Hand-off saga. `casPersistSession(sid)` must attach `sid` ONLY while the order
 * is still PENDING_PAYMENT with no other session (a single-winner CAS) and return
 * the affected row count (1 = won, 0 = lost); it may THROW on a truly transient
 * DB error (bounded-retried here). All failure results carry the sessionId for
 * recovery logging.
 */
export async function stripeCheckoutHandoff(
  db: PrismaClient,
  api: StripeSessionApi | null,
  orderId: string,
  casPersistSession: (sessionId: string) => Promise<number>,
): Promise<StripeHandoffResult> {
  // 1) No Stripe → no session created.
  if (!api) {
    const out = await boundedCleanup(db, api, orderId);
    return out === 'canceled' || out === 'noop'
      ? { ok: false, reason: 'no-session', sessionId: null }
      : { ok: false, reason: 'cleanup-failed', sessionId: null };
  }
  // 2) Create the session.
  let session: { id: string; url: string | null };
  try { session = await api.create(); } catch {
    const out = await boundedCleanup(db, api, orderId);
    return out === 'canceled' || out === 'noop'
      ? { ok: false, reason: 'no-session', sessionId: null }
      : { ok: false, reason: 'cleanup-failed', sessionId: null };
  }
  const sid = session.id;

  // 3) CAS-persist the session id BEFORE any redirect. Retry only truly transient throws.
  let count: number | null = null;
  for (let i = 0; i < 3; i++) {
    try { count = await casPersistSession(sid); break; } catch { count = null; }
  }
  if (count === 0) {
    // CAS lost — the order is no longer a pending, unclaimed order (canceled/paid,
    // or a different session won). Our session must never stay payable against it.
    // If we cannot CONFIRM it expired, surface session-orphaned (don't pretend safe);
    // do NOT cancel/restock (not ours to touch).
    if (!(await boundedExpire(api, sid))) return { ok: false, reason: 'session-orphaned', sessionId: sid };
    return { ok: false, reason: 'cas-lost', sessionId: sid };
  }
  if (count === null || !session.url) {
    // Transient persist failure (unknown outcome) OR no payable URL. Expire OUR
    // session FIRST; only after confirmed expiration cancel+restock — CAS on OUR
    // own session id (null or `sid`), never a foreign session another writer attached.
    if (!(await boundedExpire(api, sid))) return { ok: false, reason: 'session-orphaned', sessionId: sid };
    const out = await boundedCancelOwn(db, orderId, sid);
    return out === 'failed'
      ? { ok: false, reason: 'cleanup-failed', sessionId: sid }
      : { ok: false, reason: 'no-session', sessionId: sid };
  }
  // 4) Success — persisted (single winner) + payable.
  return { ok: true, url: session.url };
}
