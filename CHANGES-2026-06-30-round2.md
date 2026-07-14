# CHANGES — 2026-06-30 (round2)

Round focus: **extend the idempotency sweep past order-status** to the two
buyer-facing non-order status mutations, and re-confirm the keystone blocker.
(A first round dated 2026-06-30 already shipped BUG-040 late on the 29th; this is
the morning-of-30th run, suffixed `-round2` to avoid clobbering that manifest.)
Apply these to git manually.

## Files changed

### `src/lib/quotes/actions.ts` — BUG-041 (P2, state-integrity/trust)
`setQuoteStatus` used snapshot-read + **unconditional** `sourcingRequest.update` +
**unconditional** `audit('quote.status')`, with no source-state guard, and the
ACCEPT branch then fired **buyer-facing** `notifyUser` + `notifyAdmins`. A buyer
double-clicking "Accept" re-stamped state, double-audited, and double-notified the
buyer and admins.

Fix: atomic compare-and-set —
`updateMany({ where:{ id, status:{ not:status } }, data:{ status } })` (CLOSE→archive
branch broadens the where to `OR:[{status:{not:status}},{archivedAt:null}]`), with
`audit()` + both notifies gated on `count===1`. A `statusChanged` flag suppresses
"X → X" status-audit noise on the pure-archive path. The ACCEPT-path
`redirect(.../payment)` stays **unconditional** so a re-accept still lands the buyer
on their payment workspace (idempotent UX). Three hunks.

### `src/lib/support/actions.ts` — BUG-041 (P2 sibling)
`setTicketStatus` had the same anti-pattern (snapshot + unconditional
`supportTicket.update` + unconditional `audit('ticket.status')`). Same atomic
compare-and-set + count gate; returns a friendly idempotent `Already <status>.`
message when `count===0`. One hunk.

### `scripts/verify-status-transition-atomic.ts` — NEW
Offline regression matrix for BUG-041. Models the double-click race OLD vs NEW for
both functions: asserts NEW writes/audits/notifies exactly once, never on an
already-in-target row, redirect stays reachable on re-accept, and the legacy
CLOSED-but-unarchived single-click still archives. Pure in-memory model (no
DB/network). `node --experimental-strip-types …` → 17/17 PASS, exit 0.

### `BUGS.md`, `INVARIANTS.md`
Round log: BUG-041 entry (P2) + deferred terminal-transition-policy note;
2026-06-30 round2 BUG-033 re-probe (still unreachable — empty body — and Chrome
not non-interactively selectable in an unattended run); invariant addendum.

## Posture / safety
- Manual-payment posture intact — no Stripe / card / "pay now" copy touched. Quote
  ACCEPT already routes to the manual bank-transfer payment workspace; that wording
  is unchanged.
- No schema change, no Stripe coupling, future-Stripe-readiness intact.
- No destructive SQL. No production access. Code-only round. Not a drive-by
  refactor — change confined to the two functions.

## Verification
- `npx tsc --noEmit` → exit 0 (before and after).
- All seven offline matrices exit 0: verify-status-transition-atomic (new),
  verify-archive-idempotent, verify-expired-restock-once,
  verify-confirm-delivery-atomic, verify-reject-payment-atomic,
  verify-restock-once-guard, verify-receipt-in-flight-guards.
- Diffs vs `.backups/bug041-2026-06-30/*.bak` = intended hunks only; both source
  files remain LF (`grep -c $'\r'` = 0).
- BUG-041 remains **browser-unverified** — proper check is a seeded concurrent
  double-submit against real buyer/admin sessions, gated on BUG-033 + a connected,
  non-interactively-selectable Chrome.

## Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker.
- BUG-005 (email-verification rollout) — deliverability + backfill decision.
- BUG-020 (notification inbox / Resend domain verify) — owner edits in `/admin/settings`.
- BUG-033 (site reachability) — keystone; needs the deployed site reachable AND a
  Chrome that can be selected without interactive prompts during the run.
