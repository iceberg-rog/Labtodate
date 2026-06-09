# lab2date — Production Invariants & Release-Blocker Matrix

Updated by Cowork orchestrator. **Every item below must be GREEN to ship.**

Legend: ✅ verified · 🟡 partial · ❌ broken · ⏳ untested

---

## 1. Financial Integrity (P0 — money)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| F1 | `Order.totalCents == subtotalCents + shippingCents + taxCents` | `cart/actions.checkoutCart`, `orders/actions.startCheckoutWithAddress` | ⏳ |
| F2 | One `Order.stripeSessionId` maps to one Stripe session, and one `stripePaymentIntentId` maps to one PaymentIntent. Both unique in DB. | schema `@unique` | ✅ schema |
| F3 | `checkout.session.completed` webhook is idempotent — replay must NOT re-send invoice or re-notify | `api/stripe/webhook` | 🟡 code fix present (BUG-002); browser-unverified |
| F4 | `checkout.session.expired` only cancels orders still `PENDING_PAYMENT` and only releases stock once | `api/stripe/webhook` | ✅ |
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
| F15 | `paymentVerificationStatus` transitions: null → AWAITING_VERIFICATION → VERIFIED|REJECTED; no skipping | `verifyPayment`/`rejectPayment` precondition + atomic `updateMany` WHERE guard (admin/actions.ts:2295-2392); buyer upload resets cleanly | ✅ code-verified 2026-06-07 |

## 2. Permissions / Auth (P0 — security)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| A1 | A buyer cannot read/modify another buyer's order | `requireSession` + `buyerId === session.user.id` | ✅ in `confirmDelivery`, `requestReturn`, `buyerSubmitPaymentProof` |
| A2 | A seller cannot read/edit another seller's product | `existing.sellerId !== userId && role !== 'ADMIN'` | ✅ in seller actions |
| A3 | A seller cannot publish a product without admin review | `publishProduct` gates seller to DRAFT↔PENDING_REVIEW (BUG-001) | ✅ code; browser-unverified |
| A4 | Admin endpoints check `adminCaps` via `requireCapability`, not just role | `lib/auth-server.requireCapability` | ⏳ verify each admin action |
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
| S1 | `CartItem` quantity ≤ `Product.quantity` at all times read | cart actions clamp via `Math.min(want, product.quantity, 99)` | ✅ at write time; **stale on subsequent reads** |
| S2 | At checkout, cart re-validates stock and rolls back partial reservations | `checkoutCart` reservation loop | ✅ |
| S3 | Order status transitions are monotonic per business rule: PENDING_PAYMENT → PAID → PROCESSING → SHIPPED → DELIVERED; or → CANCELED/REFUNDED | `setOrderFulfillment` now enforces full forward-only monotonicity (BUG-026): blocks exit from terminal REFUNDED/CANCELED (BUG-022), backward funnel moves (DELIVERED→PROCESSING etc.), fulfilling an unpaid order (PENDING_PAYMENT→ship), and CANCELED/REFUNDED set via the fulfilment panel (bounced to refund/cancel actions). Payment→PAID still owned by markOrderPaidManually/verifyPayment. | ✅ code (BUG-026; browser-unverified) |
| S4 | Cancelling an order returns stock once and only once | `webhook expired` branch; admin `cancelOrder` status precondition + `increment` restock, `refundOrder` idempotency guard + `$transaction` (admin/actions.ts:2399-2485) | ✅ both paths code-verified 2026-06-07 |
| S5 | Proforma expiry cron closes sourcing AND linked order in a single transaction | `sla-sweep` uses `prisma.$transaction` | ✅ |
| S6 | `lastReplyAt` / `lastReplyByStaff` on tickets/quotes always reflect the newest message | server actions | ✅ browser-VERIFIED (staff reply on TEST ticket 2026-05-29) |
| S7 | Notification `readAt` only flips forward (no un-read after batch-mark-read) | needs check | ⏳ |
| S8 | Cart cleared on successful order creation (no leftover items in another tab) | `checkoutCart` does `cartItem.deleteMany` | ✅ |
| S9 | Multi-tab cart — refreshing tab B after tab A checked out shows empty cart | ⏳ browser audit |
| S10 | Product `status=ARCHIVED` removes it from marketplace listings but keeps order history | all list/search/sitemap queries filter PUBLISHED ✅; detail page had NO gate (BUG-024) — now 404s non-PUBLISHED except owner/admin preview; order history keeps product (intentional, verified) | ✅ code (BUG-024; browser-unverified) |

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

## Release-Ready Definition

- **Every P0 GREEN** (no ❌ in F1–F15, A1–A15, S1–S10)
- **Every browser regimen B1–B17 PASS** under full regimen (repeat/refresh/back/multi-tab/etc.)
- **No P1 regression** introduced by fixes
- **BUGS.md** has zero open P0/P1 items
