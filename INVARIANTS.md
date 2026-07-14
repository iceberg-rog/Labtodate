# lab2date — Production Invariants & Release-Blocker Matrix

Updated by Cowork orchestrator. **Every item below must be GREEN to ship.**

Legend: ✅ verified · 🟡 partial · ❌ broken · ⏳ untested

---

## 1. Financial Integrity (P0 — money)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| F1 | `Order.totalCents == subtotalCents + shippingCents + taxCents` | all 3 creation sites (`orders/actions.startCheckoutWithAddress`, `cart/actions.startCartCheckoutWithAddress`, `quotes/actions.sendProforma` materialize) compute total = subtotal+shipping+tax; item snapshots consistent (qty×price = subtotal); BUG-023 re-issue path keeps totals+snapshot in sync atomically | ✅ code-verified 2026-06-11 (browser ⏳) |
| F2 | One `Order.stripeSessionId` maps to one Stripe session, and one `stripePaymentIntentId` maps to one PaymentIntent. Both unique in DB. | schema `@unique` | ✅ schema |
| F3 | `checkout.session.completed` webhook is idempotent — replay must NOT re-send invoice or re-notify | `api/stripe/webhook` | 🟡 code fix present (BUG-002); browser-unverified |
| F4 | `checkout.session.expired` only cancels orders still `PENDING_PAYMENT` and only releases stock once | `api/stripe/webhook` — 2026-06-28 (BUG-039): the in-memory `status==='PENDING_PAYMENT'` guard + unconditional `order.update`/restock (last snapshot-then-unconditional order-status mutation, dead under manual posture but Stripe-path code kept future-ready) is now an atomic `order.updateMany({where:{id,status:'PENDING_PAYMENT'}})` claim with restock gated on `count===1`; a redelivered `expired` event can no longer double-restock. Offline matrix: `scripts/verify-expired-restock-once.ts` (exit 0). | ✅ code (BUG-039; browser ⏳) |
| F5 | Stock decrement is atomic — same unit cannot be sold twice (concurrent buyers) | `prisma.product.updateMany({ quantity:{gte:1}, decrement:1 })` | ✅ |
| F6 | Stock rollback if Stripe `sessions.create` throws | catch in `startCheckoutWithAddress` / `checkoutCart` | ✅ |
| F7 | Single-currency-per-order — no silent EUR↔USD summing | cart `valid.some(...) !== currency` | ✅ |
| F8 | Proforma TTL — buyer cannot submit payment proof after `validUntilAt` passed | `payment/actions.buyerSubmitPaymentProof` (defense-in-depth) + cron sweep | ✅ |
| F9 | Two-step payment verification — proof can only be uploaded while order is `PENDING_PAYMENT` | `payment/actions` status guard | ✅ |
| F10 | `OrderItem.priceCentsSnapshot` is immutable — frozen at order time | OrderItem schema | ✅ schema |
| F11 | `proformaNumber` immutable once issued | ✅ by construction: single write site `sendProforma` reuses existing (`sr.proformaNumber \|\| …`); value deterministic from sr.id (verified 2026-06-07) | ✅ code |
| F12 | Refund flow — refunded order doesn't allow re-fulfilment | `setOrderFulfillment` terminal-state guard (BUG-022) | ✅ code; browser-unverified |
| F13 | Currency display matches order currency (no hardcoded €) in notifications | `notifyAdmins` in webhook, cart & orders actions | ✅ code (BUG-003; browser-unverified) |
| F14 | No order can exist with `status=PAID` and `paidAt=null` (or vice versa) | webhook sets both atomically | ✅ |
| F15 | `paymentVerificationStatus` transitions: null → AWAITING_VERIFICATION → VERIFIED|REJECTED; no skipping; VERIFIED must not regress to REJECTED | both `verifyPayment` AND `rejectPayment` now claim the transition with a conditional `updateMany({where:{id, paymentVerificationStatus:'AWAITING_VERIFICATION', status:'PENDING_PAYMENT'}})` + `count===1` gate on all side effects. 2026-06-25 (BUG-037): `rejectPayment` was previously a snapshot-guard + unconditional `update({where:{id}})` that could overwrite a just-verified PAID order (PAID+REJECTED corruption) and double-notify on double-click; now symmetric with `verifyPayment`. Offline matrix: `scripts/verify-reject-payment-atomic.ts` (exit 0). | ✅ code-verified 2026-06-07; BUG-037 atomicity 2026-06-25 (browser ⏳) |

## 2. Permissions / Auth (P0 — security)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| A1 | A buyer cannot read/modify another buyer's order | `requireSession` + `buyerId === session.user.id` | ✅ in `confirmDelivery`, `requestReturn`, `buyerSubmitPaymentProof` |
| A2 | A seller cannot read/edit another seller's product | `existing.sellerId !== userId && role !== 'ADMIN'` | ✅ in seller actions |
| A3 | A seller cannot publish a product without admin review | `publishProduct` gates seller to DRAFT↔PENDING_REVIEW (BUG-001) | ✅ code; browser-unverified |
| A4 | Admin endpoints check `adminCaps` via `requireCapability`, not just role | `lib/auth-server.requireCapability` | ✅ code (BUG-030; browser-unverified) — full sweep 2026-06-10: 15 actions were role-only (privilege-escalation gap) → now capability-gated to match the nav/section model; remaining role-only actions are own-data self-service (notifications) |
| A5 | Suspended users cannot sign in (sign-in hook) | `auth.ts` hooks.before | ✅ |
| A6 | Magic-link expiry: 10 min (sign-in), 14 days (guest ticket token), 1 hour (password reset) | `auth.ts` + schema | ✅ |
| A7 | Guest ticket/quote access tokens are unguessable and rotatable | `accessToken @unique` + admin reissue | ✅ schema |
| A8 | Role cannot be set client-side at sign-up | `additionalFields.role.input: false` | ✅ |
| A9 | `/api/upload` requires SELLER or ADMIN role | route handler | ✅ |
| A10 | Cron `/api/cron/sla-sweep` requires `X-Cron-Secret` header | route handler | ✅ |
| A11 | Stripe webhook requires valid signature | `stripe.webhooks.constructEvent` | ✅ |
| A12 | Password min length 12 | `auth.ts` | ✅ raised 8→12 (BUG-006) |
| A13 | Email verification not required on sign-up (`requireEmailVerification: false`) | `auth.ts` | 🟡 **risk** — anyone can register with another's email |
| A14 | Rate-limit on sign-up / sign-in / forgot-password to stop credential stuffing | was ❌ (auth route had NO limits — BUG-025); now per-IP limits in `api/auth/[...all]/route.ts` POST | ✅ code (BUG-025; browser-unverified) |
| A15 | `deleteProduct` does not allow seller to nuke products with order history | routes to ARCHIVED if any OrderItem exists (BUG-004) | ✅ code; browser-unverified |

## 3. State Consistency (P0/P1)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| S1 | `CartItem` quantity ≤ `Product.quantity` at all times read | write-time clamp (`Math.min(want, product.quantity, 99)`) + read-time surfacing (BUG-032): cart page shows sold-out / only-N-left badges + disables CTA; `/checkout/cart` redirects stale carts back; checkout no longer silently drops sold-out items (they fail the atomic reservation → rollback → explained banner) | ✅ code (BUG-032; browser-unverified) |
| S2 | At checkout, cart re-validates stock and rolls back partial reservations | `checkoutCart` reservation loop | ✅ |
| S3 | Order status transitions are monotonic per business rule: PENDING_PAYMENT → PAID → PROCESSING → SHIPPED → DELIVERED; or → CANCELED/REFUNDED | `setOrderFulfillment` now enforces full forward-only monotonicity (BUG-026): blocks exit from terminal REFUNDED/CANCELED (BUG-022), backward funnel moves (DELIVERED→PROCESSING etc.), fulfilling an unpaid order (PENDING_PAYMENT→ship), and CANCELED/REFUNDED set via the fulfilment panel (bounced to refund/cancel actions). 2026-06-27 (BUG-038): the buyer-side `confirmDelivery` (SHIPPED→DELIVERED) was the last status mutation using snapshot-then-unconditional-update; now a conditional `updateMany({where:{id,status:'SHIPPED'}})` + `count===1` gate, so it cannot regress a row an admin concurrently refunded (REFUNDED→DELIVERED) nor double-notify on double-click. Payment→PAID still owned by markOrderPaidManually/verifyPayment. | ✅ code (BUG-026; browser-unverified) |
| S4 | Cancelling an order returns stock once and only once | `webhook expired` branch; admin `cancelOrder` status precondition + `increment` restock, `refundOrder` idempotency guard + `$transaction` (admin/actions.ts:2399-2485). 2026-06-19 (BUG-035): `cancelOrder`/`bulkCancelOrders` now also refuse orders with a receipt in flight (`paymentSubmittedAt != null`) so a paid-but-unverified order is never canceled with a false "no charge was made" notice. | ✅ both paths code-verified 2026-06-07; BUG-035 guard 2026-06-19 |
| S5 | Proforma expiry cron closes sourcing AND linked order in a single transaction | `sla-sweep` uses `prisma.$transaction` | ✅ |
| S6 | `lastReplyAt` / `lastReplyByStaff` on tickets/quotes always reflect the newest message | server actions | ✅ browser-VERIFIED (staff reply on TEST ticket 2026-05-29) |
| S7 | Notification `readAt` only flips forward (no un-read after batch-mark-read) | `markNotificationRead`/`markAllNotificationsRead` guard `where:{readAt:null}`; no un-read action exists → write-once | ✅ code-verified 2026-06-10 (cross-tab live sync still ⏳ browser) |
| S8 | Cart cleared on successful order creation (no leftover items in another tab) | `checkoutCart` does `cartItem.deleteMany` | ✅ |
| S9 | Multi-tab cart — refreshing tab B after tab A checked out shows empty cart | ⏳ browser audit |
| S10 | Product `status=ARCHIVED` removes it from marketplace listings but keeps order history | all list/search/sitemap queries filter PUBLISHED ✅; detail page had NO gate (BUG-024) — now 404s non-PUBLISHED except owner/admin preview; order history keeps product (intentional, verified) | ✅ code (BUG-024; browser-unverified) |
| S11 | A receipt-in-flight order (`status=PENDING_PAYMENT` AND `paymentSubmittedAt != null`, i.e. `AWAITING_VERIFICATION`) is NEVER auto/bulk-canceled — only admin verify/reject may move it | All four cancel paths guard `paymentSubmittedAt`: cron proforma-expiry (BUG-034), cron orphan sweep (BUG-007), admin `bulkCancelOrders` + single `cancelOrder` (BUG-035). Offline regression matrix: `scripts/verify-receipt-in-flight-guards.ts` (exit 0). | ✅ code + offline-logic-verified 2026-06-19; browser-unverified |

## 4. UX / Notifications (P1)

| # | Invariant | Status |
|---|---|---|
| N1 | Buyer receives 1 invoice email per paid order (not 2-3 due to webhook replay) | ❌ broken — depends on F3 |
| N2 | "Payment received" in-app notification appears within seconds of webhook | ✅ |
| N3 | Admin receives notification for new events (orders/tickets/quotes) | ✅ browser-VERIFIED (live toast on TEST ticket 2026-05-29) |
| N4 | SLA-breach notification fires once per ticket per breach cycle | ✅ idempotent via `slaBreachAt` |
| N5 | Proforma-expired email goes to buyer and admin once | ✅ idempotent via status flip |

## 5. End-to-End Flows Requiring Full Audit (Browser regimen: repeat/refresh/back/multi-tab/stale/duplicate/permission/notification/reload/reconnect)

- [ ] B1: Anonymous browse → product → sign-up redirected → return → add to cart
- [ ] B2: Add to cart → refresh → cart preserved
- [ ] B3: Add to cart in tab A, also in tab B → no over-quantity
- [ ] B4: Checkout (Stripe) → back button mid-Stripe → return to cart shows reserved or released stock?
- [ ] B5: Checkout → close tab → expired session → stock returned
- [ ] B6: Payment proof upload → refresh → status persisted
- [ ] B7: Buyer tries to access another buyer's `/app/orders/X`
- [ ] B8: Seller publishes product directly (currently allowed — **bug A3**)
- [ ] B9: Seller tries to edit another seller's product via slug
- [ ] B10: Admin without `orders:refund` cap tries to refund — must redirect to forbidden
- [ ] B11: Duplicate-submit of `/checkout` form (double-click) — must not double-reserve
- [ ] B12: Reload of `/checkout/success?session_id=...` — webhook race condition?
- [ ] B13: Notification bell — mark-as-read sync across tabs
- [ ] B14: Sign-out from tab A → tab B sees expired session on next action
- [ ] B15: Password reset link reuse → second use must fail
- [ ] B16: Magic-link token expires after 10 min — verify
- [ ] B17: Suspended user attempts sign-in → blocked with reason

---

## Build health (added 2026-06-09)

- **Hard gate: `tsc --noEmit` must exit 0.** On 2026-06-09 it exited 2 — the build
  was broken on arrival by a mass filesystem-corruption event (35 files; see
  BUG-027) compounded by a non-compiling duplicated block committed to HEAD
  (BUG-028) and a wiped untracked component (BUG-029). All recovered; `tsc` = 0.
- **A12** (password min length 12) was silently regressed to 8 in HEAD; re-applied
  this round — now genuinely GREEN at code level.
- Caveat: this round's recovery is **code-level only** (Chrome not connected). The
  many `FIXED (code; browser-unverified)` items below remain browser-unverified.
- **2026-06-11:** the filesystem truncation fault is STILL ACTIVE — BUGS.md and
  INVARIANTS.md were both tail-truncated mid-round and reconstructed from the
  in-session reads. Safety copies: `.backups/ledger-2026-06-11/`.

## Reliability / infra config (added 2026-06-13)

- **BUG-015** (RSC `_rsc` prefetch 503 under concurrent burst) fixed in-repo via
  `nginx/lab2date.conf`: upstream keepalive pool (64) + conditional
  `Connection` header (`map`), so SSR bursts reuse connections instead of
  exhausting the single standalone upstream. Deploy-pending; run `nginx -t`
  before reload. Browser-unverified (Chrome not connected).
- **BUG-016** (blog cover 403) fixed in-repo per-prefix: `blog-cover/*` added to
  the anonymous-read grant in both `docker-compose.yml` `minio-init` and the
  authoritative `src/lib/storage/s3.ts` `ensureBucket()` policy. PRIVATE prefixes
  (`support-att/*`, payment `proof`) deliberately remain non-public.

## Release-Ready Definition

- **Every P0 GREEN** (no ❌ in F1–F15, A1–A15, S1–S10)
- **Every browser regimen B1–B17 PASS** under full regimen (repeat/refresh/back/multi-tab/etc.)
- **No P1 regression** introduced by fixes
- **BUGS.md** has zero open P0/P1 items

## Browser-verification status (added 2026-06-14)

- **Chrome connected for the first time this loop** — but `https://labtodate.com`
  would not load in the audit browser (Chrome error page on every nav; control
  nav to example.com succeeded). Logged as **BUG-033 (P0, reachability)**.
- Consequence: the entire "FIXED (code; browser-unverified)" backlog and browser
  regimen **B1–B17 remain ⏳ UNVERIFIED**. No item may be promoted to ✅
  browser-VERIFIED until the deployed site is reachable and a real session
  exercises the flow (hard rule). The 2026-05-29 browser-VERIFIED items (S6, N3,
  the VERIFIED-section chains) stand as prior evidence and are unaffected.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-15)

- **BUG-033 re-probed — still BLOCKED.** Chrome connected (1 local Windows
  browser); `https://labtodate.com` again would not load (Chrome error page; only
  `data:` placeholder requests; control `example.com` loaded fine in the same
  session). No document request reached the origin. Symptom unchanged from
  2026-06-14.
- Consequence: B1–B17 and every "FIXED (code; browser-unverified)" item remain
  ⏳ UNVERIFIED. No promotion to ✅ browser-VERIFIED is permitted until the
  deployed site is reachable and a real session exercises the flow (hard rule).
  The 2026-05-29 browser-VERIFIED items (S6, N3) stand and are unaffected.
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-15 (green). No source
  changed this round.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-16)

- **BUG-033 re-probed — still BLOCKED.** Chrome connectivity check returned no
  connected browser (`list_connected_browsers` = []). No browser session was
  possible, so `https://labtodate.com` could not be exercised. B1–B17 and every
  "FIXED (code; browser-unverified)" item remain ⏳ UNVERIFIED. The 2026-05-29
  browser-VERIFIED items (S6, N3) stand and are unaffected.
- **F1 strengthened (display side).** BUG-031 closed: the proforma payment-
  instructions snapshot now derives its amount from the same
  `subtotal + shipping + tax` total the materialized order records, so the figure
  the buyer is told to bank-transfer can never be less than `order.totalCents`.
  Code-verified (offline simulation across 0/0, ship>0, tax>0, mixed cents);
  browser-unverified. No financial invariant regressed; manual-payment posture
  intact (bank-transfer wording only).
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-16 (green).
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-17)

- **BUG-033 re-probed — still BLOCKED, with the strongest disambiguation yet.**
  A real browser WAS connected this round (`list_connected_browsers` → 1 local
  Windows "Browser 1"). Control nav to `https://example.com/` loaded a real page
  in the audit tab; nav to `https://labtodate.com/` (3 attempts) left the frame
  on a Chrome **error page** (`get_page_text`/`read_page`/`screenshot` all error
  "Frame with ID 0 is showing error page"); no origin document request recorded.
  So the fault is the deployed site, not the browser. Likely DNS/origin/TLS/
  deployment availability — needs the owner to confirm labtodate.com is served.
- Consequence: B1–B17 and every "FIXED (code; browser-unverified)" item remain
  ⏳ UNVERIFIED. No promotion to ✅ browser-VERIFIED is permitted (hard rule).
  The 2026-05-29 browser-VERIFIED items (S6, N3) stand and are unaffected.
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-17 (green). No source
  changed this round (all OPEN items BLOCKED — no non-blocked code target).
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-18)

- **BUG-033 re-probed — still BLOCKED.** Browser connected ("Browser 1", local
  Windows). Control nav to `https://example.com/` loaded a real page;
  `get_page_text` returned real content. Target nav to `https://labtodate.com/`
  left the frame on a Chrome error page ("Frame with ID 0 is showing error
  page"); `read_network_requests` showed only the error page's own inline
  `data:` image assets — zero requests to the origin. Independent
  `web_fetch https://labtodate.com/` returned an empty body. Fault is the
  deployed site, not the browser. Needs owner to confirm DNS/origin/TLS/nginx.
- Consequence: B1–B17 and every "FIXED (code; browser-unverified)" item remain
  ⏳ UNVERIFIED (hard rule). The 2026-05-29 browser-VERIFIED items (S6, N3) stand.
- **New invariant reinforced — P4 (payment-state authority).** Cron must never
  cancel an order that has a buyer receipt in flight. BUG-034 fixed a
  proforma-expiry sweep that cancelled linked `PENDING_PAYMENT` orders without
  checking `paymentSubmittedAt`, which could destroy an order whose buyer paid
  and is `AWAITING_VERIFICATION`. The sweep now skips any proforma with an
  in-flight receipt and additionally guards the cancel `updateMany` on
  `paymentSubmittedAt: null` (same posture as the orphan sweep). This restores
  the rule that **only admin verify/reject changes payment state**; no automated
  job may move a paid-but-unverified order out of the verify queue.
  Code-verified (read + diff + tsc); browser-unverified — cron path has no UI,
  proper check is a seeded integration run (logged as a follow-up task).
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-18 (green), before and
  after the BUG-034 change.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-19)

- **BUG-033 re-probed — still BLOCKED.** Browser connected ("Browser 1", local
  Windows). Control nav to `https://example.com/` loaded a real page
  (`get_page_text` returned real content). Target nav to `https://labtodate.com/`
  left the frame on a Chrome error page ("Frame with ID 0 is showing error
  page"). Verdict unchanged from 06-14/15/17/18: the deployed site is
  unreachable while a control origin loads in the same session → site/deploy
  fault, not the browser. Needs owner to confirm DNS/origin/TLS/nginx. B1–B17
  and the browser-unverified backlog remain ⏳ UNVERIFIED.
- **New invariant S11 (receipt-in-flight protection) — generalized from P4.**
  BUG-035: the admin cancel paths (`bulkCancelOrders` + single `cancelOrder`)
  had the SAME gap BUG-034 fixed in the cron — they canceled purely on
  `status=PENDING_PAYMENT`, so an order whose buyer had uploaded a receipt and
  was `AWAITING_VERIFICATION` could be canceled (silently in bulk) and the buyer
  told "no charge was made" — false. Fixed: bulk excludes `paymentSubmittedAt`
  orders (candidate query + race-guarded `updateMany`) and reports the skipped
  count; single cancel throws an instructive error directing the operator to
  Verify/Reject first. All four cancel paths now share one guard, codified as a
  runnable regression matrix (`scripts/verify-receipt-in-flight-guards.ts`,
  exit 0). Decision-neutral, no Stripe coupling, manual-payment-posture-safe.
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-19 (green), before and
  after the BUG-035 change.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-20)

- **BUG-033 re-probed - still BLOCKED.** Browser connected ("Browser 1", local
  Windows). Control nav to `https://example.com/` loaded a real page
  (`get_page_text` returned the real "Example Domain" body). Target nav to
  `https://labtodate.com/` left the frame on a Chrome error page;
  `read_network_requests(urlPattern:"labtodate")` recorded ZERO requests to the
  origin. Verdict unchanged from 06-14/15/17/18/19: deployed site unreachable
  while a control origin loads -> site/deploy fault, not the browser. Needs owner
  to confirm DNS/origin/TLS/nginx. B1-B17 and the browser-unverified backlog
  remain untested.
- **S4 strengthened - restock-once is now atomic (BUG-036).** The admin single
  `cancelOrder` and `refundOrder` previously transitioned status with an
  unconditional `update({where:{id}})` after a snapshot read, then restocked.
  Two concurrent admin clicks both passed the snapshot guard and both ran the
  restock loop -> `Product.quantity` double-incremented and the buyer
  double-notified (the manual/no-Stripe path had nothing upstream to dedupe).
  Both now claim the transition with a conditional `updateMany`
  (cancel: `status:'PENDING_PAYMENT', paymentSubmittedAt:null`; refund:
  `status:{not:'REFUNDED'}`) and gate restock + side effects on `count===1`,
  the same atomic pattern `markOrderPaidManually` already used. Codified as a
  runnable concurrency regression matrix (`scripts/verify-restock-once-guard.ts`,
  exit 0: NEW restocks once, OLD double-restocks). Decision-neutral, no Stripe
  coupling, manual-payment-posture-safe. Browser-unverified (server-only action;
  proper check is a seeded concurrent integration run, gated on BUG-033).
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-20 (green), before and
  after the BUG-036 change (one Edit-tool tail-truncation incident this round,
  reverted from backup and re-applied via atomic Python rewrite; see BUGS.md).
- Release-Ready remains gated on B1-B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-27)

- **BUG-033 NOT re-probed — no browser connected.** `list_connected_browsers`
  returned `[]` this round, so no audit session was possible and
  `https://labtodate.com` could not be exercised. B1-B17 and every
  "FIXED (code; browser-unverified)" item remain UNVERIFIED. The 2026-05-29
  browser-VERIFIED items (S6, N3) stand and are unaffected.
- **S3/F12 strengthened — confirmDelivery is now atomic (BUG-038).** The buyer
  delivery-confirmation was the final order-status mutation still doing a
  snapshot read then an unconditional `order.update`. It could (a) regress a
  terminal REFUNDED row back to DELIVERED when an admin refunded the SHIPPED
  order concurrently (refund had already restocked + emailed) — an S3 monotonicity
  + F12 violation with the unit oversellable — and (b) double-notify admins on a
  buyer double-click. Now a conditional `updateMany({where:{id,status:'SHIPPED'}})`
  with every side effect gated on `count===1`, matching the admin siblings
  (setOrderFulfillment / cancelOrder / refundOrder / verifyPayment / rejectPayment).
  Codified as a runnable race matrix (`scripts/verify-confirm-delivery-atomic.ts`,
  exit 0: NEW notifies once + preserves REFUNDED; OLD double-notifies +
  corrupts REFUNDED->DELIVERED). Decision-neutral, no Stripe coupling,
  manual-payment-posture-safe. Browser-unverified (buyer-session server action;
  proper check is a seeded concurrent confirm/refund integration run, gated on
  BUG-033 + a connected Chrome).
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-27 (green), before and
  after the BUG-038 change. One Python-rewrite line-ending incident (CRLF->LF on
  the whole file) caught by diff-vs-backup and reverted; re-applied in binary
  mode preserving CRLF.
- Release-Ready remains gated on B1-B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-28)

- **BUG-033 re-probed — still BLOCKED.** `list_connected_browsers` returned `[]`
  (no Chrome connected this run), so the deployed origin could not be exercised.
  B1–B17 and every "FIXED (code; browser-unverified)" item remain ⏳ UNVERIFIED.
  The 2026-05-29 browser-VERIFIED items (S6, N3) stand and are unaffected.
- **F4 strengthened (BUG-039).** The Stripe `checkout.session.expired` branch was
  the last order-status mutation still using the snapshot-then-unconditional-
  `update` + unconditional restock pattern the S3/S4 sweep (BUG-002/026/035/036/
  037/038) removed everywhere else. Now an atomic `updateMany` claim gates restock
  on `count===1` → release-stock-once is genuinely race-safe, symmetric with the
  rest of the sweep. Dead under manual posture (Stripe off), kept future-ready; no
  copy, schema, or posture change. Code-verified + offline-matrix-verified;
  browser-unverified.
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-28 (green). All five
  offline regression matrices (`verify-expired-restock-once`,
  `verify-confirm-delivery-atomic`, `verify-reject-payment-atomic`,
  `verify-restock-once-guard`, `verify-receipt-in-flight-guards`) exit 0.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.

## Browser-verification status (updated 2026-06-30)

- **BUG-033 re-probed — still BLOCKED.** Two Chrome browsers were connected this
  run (`list_connected_browsers` → "Browser 1" + "Browser 2", both local Windows),
  but using one for an audit requires interactive user browser-selection (the tool
  mandates listing every connected browser for a human to pick) — impossible in an
  unattended scheduled run. Independent `web_fetch https://labtodate.com/` again
  returned an **empty body** → deployed origin still unreachable. Verdict unchanged
  from 06-14…06-28: site/deploy fault, needs owner to confirm DNS/origin/TLS/nginx.
  B1–B17 and every "FIXED (code; browser-unverified)" item remain ⏳ UNVERIFIED.
  The 2026-05-29 browser-VERIFIED items (S6, N3) stand and are unaffected.
- **Atomicity sweep CONFIRMED complete (adversarial re-audit).** Every
  `prisma.order.(update|updateMany)` site in `src/` was reviewed: all order
  **status transitions** go through an atomic `updateMany` claim gated on
  `count === 1`. The only remaining unconditional `order.update({…status:'CANCELED'})`
  calls are the Stripe-`sessions.create`-throw rollbacks (orders/cart actions),
  which cancel an order created microseconds earlier in the same request with no
  concurrent actor — correctly F6, dead under manual posture. BUG-039's "last
  status mutation" claim holds; no missed instance.
- **Audit-integrity hardened — BUG-040.** `archiveOrder` / `unarchiveOrder` were
  the last admin order mutations still using snapshot-guard + unconditional
  `update` + unconditional `audit()` (the BUG-010 "kills audit ×17" class, on the
  non-status `archivedAt` field). Both now use an atomic
  `updateMany({where:{id, archivedAt: null | {not:null}}})` claim with `audit()`
  gated on `count===1`, so a concurrent double-click archives/unarchives and audits
  exactly once. P3 (audit-trail only — no money/stock/notify). Offline matrix:
  `scripts/verify-archive-idempotent.ts` (exit 0). Manual-payment-posture-safe; no
  schema/Stripe/copy change.
- Build hard gate: `npx tsc --noEmit` exits 0 on 2026-06-30 (green), before and
  after the BUG-040 change. All six offline regression matrices
  (verify-archive-idempotent, verify-expired-restock-once,
  verify-confirm-delivery-atomic, verify-reject-payment-atomic,
  verify-restock-once-guard, verify-receipt-in-flight-guards) exit 0.
- Release-Ready remains gated on B1–B17 PASS, which is blocked on BUG-033.
- **State-integrity/Trust hardened — BUG-041 (2026-06-30 round2).** The idempotency
  sweep extended past order-status to the two buyer-facing **non-order** status
  mutations: `setQuoteStatus` (quotes) and `setTicketStatus` (tickets). Both were
  still snapshot-read + unconditional `update` + unconditional `audit()` with no
  source-state guard, and the quote ACCEPT branch double-fired the buyer-facing
  `notifyUser`/`notifyAdmins`. Both now use an atomic
  `updateMany({where:{id, status:{not:status}}})` compare-and-set (the CLOSE→archive
  branch broadens to `OR:[{status:{not:status}},{archivedAt:null}]` to preserve the
  legacy single-click archive), with `audit()` + notify gated on `count===1`. The
  ACCEPT redirect stays unconditional (idempotent UX). P2 (buyer-facing duplicate
  notifications + audit/timestamp drift; no money/stock — the materialized Order is
  independently S3/S4-protected). Offline matrix:
  `scripts/verify-status-transition-atomic.ts` (exit 0). Manual-payment-posture-safe;
  no schema/Stripe/copy change. NOTE: legal *transition policy* (e.g. forbidding
  DECLINE/CLOSE of an already-ACCEPTED quote) is a deferred business decision, not
  added here.
- Build hard gate re-confirmed 2026-06-30 round2: `npx tsc --noEmit` exits 0 before
  and after BUG-041; all **seven** offline matrices exit 0 (the six above + new
  verify-status-transition-atomic). BUG-033 keystone still OPEN/BLOCKED — site
  unreachable (empty body) and Chrome not non-interactively selectable — so no
  browser-VERIFIED promotion this round.

---

## Addendum 2026-07-02 — SLA-breach sweep idempotency (BUG-042)

| ID | Invariant | Enforced in | Status |
|----|-----------|-------------|--------|
| R1 | A single SLA breach notifies/emails/audits **exactly once**, even if two cron invocations overlap (POST + sidecar GET, or a slow sweep + next tick) | `api/cron/sla-sweep` — atomic `updateMany({where:{id, slaBreachAt:null}})` claim + `count===1` gate on both the ticket and quote sweeps | 🟡 code fix present (BUG-042); browser-unverified (needs overlapping GET+POST against a reachable deploy — gated on BUG-033) |

This closes the last unguarded write path in `sla-sweep`; the proforma-expiry and
orphan-order sweeps in the same route were already atomic-claim + count-gated.

---

## Addendum 2026-07-03 — Refund status precondition (BUG-043)

| ID | Invariant | Enforced in | Status |
|----|-----------|-------------|--------|
| R2 | `refundOrder` mutates stock/status/email **only** when the order is in a money-captured status (`PAID`/`PROCESSING`/`SHIPPED`/`DELIVERED`). It can never double-restock a `CANCELED`/already-restocked order (phantom inventory of a unique unit) nor stamp `REFUNDED` + email a "refund" on a `PENDING_PAYMENT` order (no money captured). | `admin/actions.ts::refundOrder` — positive `REFUNDABLE` allow-list re-encoded in both the snapshot guard and the atomic `updateMany({where:{id, status:{in: REFUNDABLE}}})` write; restock/email/audit gated on `count===1` | 🟡 code fix present (BUG-043); browser-unverified. NOT currently UI-reachable (a PAID-family order cannot reach a restock-already state; `canRefund` gates the button) — this closes a latent defense-in-depth gap + the last money-path action still using a negative status guard. Gated on BUG-033 for a real-session promotion. |

This makes `refundOrder` consistent with `cancelOrder`, `markOrderPaidManually`,
`verifyPayment`, and `rejectPayment`, all of which positively re-encode their
allowed source-status in the write's WHERE rather than trusting the UI/snapshot.
Manual-payment-posture-safe; Stripe refund path untouched (only runs when a
`stripePaymentIntentId` exists) — no schema/Stripe/copy change.


---

## Addendum 2026-07-09 — SLA-sweep proforma-expiry overlap-safety (BUG-044)

| ID | Invariant | Enforced in | Status |
|----|-----------|-------------|--------|
| R3 | The proforma-expiry sweep fires its buyer-facing side effects (expiry email, buyer + admin notification, audit row) **exactly once** per expiry, even under overlapping/concurrent sweep invocations (GET+POST sidecar, or a sweep overrunning the next tick). | `api/cron/sla-sweep/route.ts` — proforma section: atomic `updateMany({where:{id, status:'RESPONDED'}, data:{status:'CLOSED'}})` claim; `claim.count!==1 → return` inside the tx and a `won` flag + `if(!won) continue;` gating all side effects. Mirrors the orphan sweep's `canceled` flag and the ticket/quote sweeps' `claim.count` gate (BUG-042). | 🟡 code fix present (BUG-044); browser-unverified. Gated on BUG-033 for a real-session promotion. |

This closes the last overlap-unsafe branch in `sla-sweep/route.ts`: the four sweeps
(tickets, quotes, proforma-expiry, orphan-orders) now all claim their state transition
atomically and gate side effects on winning the claim. The proforma sweep additionally
preserves the BUG-034 receipt-in-flight guard (a buyer receipt awaiting verify is never
expired/cancelled). Quote-materialised orders reserve no stock, so the sweep correctly
performs no restock — consistent with there being no `decrement` anywhere in the quote path.


---

## Addendum 2026-07-12 — Checkout stock reservation is compensated (BUG-045)

| ID | Invariant | Enforced in | Status |
|----|-----------|-------------|--------|
| S13 | Stock reserved by a checkout that does **not** produce an Order row is always released. No code path may decrement `product.quantity` and then fail without a compensating increment — because with no Order row, no sweep/cancel/refund can ever restock it, making the deficit permanent. | `lib/orders/stock.ts::releaseReservedStock` (non-throwing, `updateMany`-based), called from the `catch` around `createOrderWithUniqueNumber` in both `startCheckoutWithAddress` and `startCartCheckoutWithAddress`, and from both pre-existing rollback branches (partial-reservation, Stripe-handoff failure) | 🟡 code fix present (BUG-045); browser-unverified. Gated on BUG-033 for a real-session promotion. |

**Why this is a distinct invariant class.** Every other integrity guard in this ledger
(S4, R1-R3, the atomic-claim family) protects a transition *between two persisted
states* — both sides exist, so a losing race is recoverable. The reserve→create window
is the one place where the system holds **unpersisted** state: the stock is already
spent, but the artifact that would let anyone reverse it does not exist yet. There is
no sweep that can fix this after the fact, because there is nothing for a sweep to
find. Compensation must therefore happen **in the request**, or not at all.

Corollary (enforced by the helper, and by the matrix): a rollback path must never
throw. A rollback that throws leaves the caller 500-ing *and* the stock leaked — it
fails at exactly the moment it is the last line of defence. Both pre-existing rollback
loops violated this (bare `update` → P2025 on a concurrently-deleted product, aborting
the restore of every remaining cart line); both now route through the non-throwing
`updateMany` helper.

Reservation-before-create is itself correct and is **not** changed — it is what stops a
unique used unit being sold twice (S4). The fix adds the missing compensation, not a
reordering.
