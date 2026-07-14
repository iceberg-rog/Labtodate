# lab2date — Bug Tracker (Orchestrator-maintained)

**Severity:** P0 = release blocker · P1 = ship-with-known-risk · P2 = polish · P3 = nice-to-have

**Status:** OPEN · FIX_IN_PROGRESS · FIXED · VERIFIED (re-tested in browser) · WONTFIX

---

## OPEN

### BUG-001 · P0 · FIXED (code; browser-unverified) · Security/Business · `publishProduct` lets sellers bypass admin review

> **2026-05-31 reconcile:** fix is present in working copy (verified by code read).
> `publishProduct` now gates SELLER to DRAFT→PENDING_REVIEW / PUBLISHED→DRAFT;
> only ADMIN reaches PUBLISHED. Stale "OPEN" header corrected. Awaiting browser re-verify.

**File:** `src/app/app/seller/products/actions.ts:124`

**Symptom:** `createProduct` correctly sets new products to `PENDING_REVIEW`. But `publishProduct(slug, publish=true)` lets the **seller themselves** flip a product from DRAFT to PUBLISHED with no admin gate. Sellers can put any product live, including ones admin previously archived or marked DRAFT.

**Root cause:** No status-source check. Function only verifies ownership (`existing.sellerId !== userId`), not that the product was approved.

**Impact:**
- Unreviewed products appear in marketplace (`status === 'PUBLISHED'` is the only filter).
- Counterfeit, misleading, or sanctioned items can be listed instantly.
- Admin moderation queue (`/admin/products`) effectively bypassable.
- **Data corruption risk: low.** Business/legal/brand risk: **high**.

**Fix:** Sellers can only set DRAFT ↔ PENDING_REVIEW. Only an ADMIN with `products:approve` can move into PUBLISHED. Once PUBLISHED, seller can move back to DRAFT (unpublish) but not back to PUBLISHED without re-review.

---

### BUG-002 · P0 · FIXED (code; browser-unverified) · Financial · Stripe webhook is not idempotent

> **2026-05-31 reconcile:** fix present in working copy (verified by code read).
> Pre-check on `status === 'PENDING_PAYMENT'` + atomic `updateMany` with status
> precondition; `count !== 1` ack-and-skips side effects. Stale "OPEN" header corrected.
> NOTE: end-to-end browser verification is BLOCKED on BUG-013 (Stripe not configured on prod).

**File:** `src/app/api/stripe/webhook/route.ts:31-132`

**Symptom:** Stripe redelivers webhooks on network blips / 5xx (and sometimes spuriously). Current code unconditionally:
1. Calls `prisma.order.update({...status:'PAID', paidAt:new Date()...})` — overwrites `paidAt` on every delivery.
2. Calls `notifyAdmins(...)` — extra Slack/Discord pings.
3. Calls `notifyUser(...)` — duplicate in-app "payment received" notifications.
4. Calls `sendOrderInvoice(...)` — **buyer gets 2-3 invoice emails for one payment**.

**Root cause:** No event-ID dedupe; no status-precondition on the `where:` clause.

**Impact:**
- Duplicate invoice emails — buyer confusion, support load.
- `paidAt` timestamp drifts on each redelivery.
- Audit log noise.
- Worst case: if order was REFUNDED between two deliveries, the second delivery flips it back to PAID → reconciliation nightmare.

**Fix:**
1. Add `processedStripeEventIds` table or a `processedAt` column on Order — store event.id, ignore if seen.
2. Tighten `prisma.order.update` to `updateMany` with `where: { id: orderId, status: 'PENDING_PAYMENT' }` and check `count`. Only fire side effects when count === 1.

---

### BUG-003 · P1 · FIXED · UX/Trust · Hardcoded `€` in notifications regardless of order currency

**Files:**
- `src/app/api/stripe/webhook/route.ts:110`
- `src/lib/cart/actions.ts:134`
- `src/lib/orders/actions.ts:356`

**Symptom:** `notifyAdmins(`New order ... — €${(total/100).toFixed(2)}`)` is hardcoded `€` even for USD/GBP orders.

**Impact:** Admin Slack/Discord/Telegram shows wrong currency symbol. Misleading for ops; can cause incorrect refund/wire amounts.

**Fix:** Format with the order's `currency` field. Either symbol lookup map or use `Intl.NumberFormat(undefined, { style: 'currency', currency })`.

---

### BUG-004 · P1 · FIXED (code; browser-unverified) · Security/Data-integrity · `deleteProduct` doesn't guard against active orders

> **2026-05-31 reconcile:** fix present in working copy (verified by code read).
> `deleteProduct` now blocks hard-delete when ANY `orderItem` references the product,
> routing to `ARCHIVED` instead. Stale "OPEN" header corrected. Awaiting browser re-verify.

**File:** `src/app/app/seller/products/actions.ts:115`

**Symptom:** A seller can call `deleteProduct(slug)` on a product that has pending orders (PROCESSING / PENDING_PAYMENT / SHIPPED). Cascades wipe CartItem/WishlistItem/Review for that product silently.

**Impact:**
- Buyers' wishlists silently empty when seller un-lists.
- Buyer reviews disappear (loss of social proof + product memory).
- Active in-progress orders lose the product link (`OrderItem.productId` → null via SetNull); titleSnapshot remains, so orders survive, but search/admin tooling breaks.

**Fix:** Reject `deleteProduct` if any `OrderItem` exists with `productId` AND order status ∈ {PENDING_PAYMENT, PAID, PROCESSING, SHIPPED}. Force seller to `ARCHIVED` instead. Hard-delete only for products with no order history.

---

### BUG-005 · P1 · BLOCKED · Security · Sign-up does not require email verification

**File:** `src/lib/auth.ts:17` — `requireEmailVerification: false`

**Symptom:** Anyone can sign up with `victim@example.com` and use the platform until the real owner notices. The first email the victim receives may be an order receipt for a fraudulent order.

**Impact:**
- Account-takeover preconditioning.
- Spam accounts.
- The victim's later sign-up flow may collide with a stale account.

**Fix:** Enable `requireEmailVerification: true`. Existing accounts get a one-time "verify your email" prompt. Magic-link sign-in becomes the primary path for unverified users.

---

### BUG-006 · P2 · FIXED · Security · Password minimum 8 chars is low for a payment-handling marketplace

**File:** `src/lib/auth.ts:18` — `minPasswordLength: 8`

**Recommendation:** Raise to 10–12, and consider requiring a non-numeric character. Better-Auth doesn't natively enforce complexity, so wrap sign-up to add a Zod check or use HIBP-pwned-passwords API.

---

### BUG-007 · P1 · FIXED · Reliability · Process death between order-create and Stripe-session-create leaves orphan PENDING_PAYMENT order

**Files:**
- `src/lib/cart/actions.ts:110-188`
- `src/lib/orders/actions.ts:331-422`

**Symptom:** Order row is created (lines 110/331), then Stripe API call. If the Node process dies between create and `stripe.checkout.sessions.create` returning, you get an order with reserved stock and no Stripe session. Buyer sees "checkout failed" but stock stays decremented and order sits forever as PENDING_PAYMENT.

**Impact:** Phantom orders, slow inventory drift over months, support tickets from confused buyers.

**Fix:** A janitor cron (or extend `sla-sweep`) that cancels PENDING_PAYMENT orders older than N minutes with no `stripeSessionId` AND no `paymentSubmittedAt`. Releases reserved stock.

---

### BUG-008 · P2 · FIXED · UX · `notifyAdmins` in cart `checkoutCart` lacks the kind/code argument

**File:** `src/lib/cart/actions.ts:133` — uses 3-arg form vs. 4-arg form in single-product flow (which passes `'ORDER_NEW'`). Webhook subscribers filtering by event kind will miss cart-originated orders.

**Fix:** Add `'ORDER_NEW'` as 4th argument.

---

## To Discover (browser-audit candidates)

- B1–B17 from INVARIANTS.md §5
- Stripe webhook race: `/checkout/success` redirect lands before webhook fires → success page shows order as PENDING — verify polling/refresh behavior.
- Notifications mark-as-read sync between tabs.
- Admin role change taking effect within `cookieCache.maxAge = 60s`.

---

## FIXED (awaiting browser re-verification)

### BUG-001 · FIX_IN_PROGRESS · publishProduct hardened
`src/app/app/seller/products/actions.ts` — seller can now only move DRAFT → PENDING_REVIEW (request approval) or PUBLISHED → DRAFT (unpublish). ADMIN keeps full transitions. **Verify:** sign in as seller, attempt publish on a DRAFT product → expect status PENDING_REVIEW, NOT PUBLISHED.

### BUG-002 · FIX_IN_PROGRESS · Stripe webhook idempotent
`src/app/api/stripe/webhook/route.ts` — pre-check `current.status === 'PENDING_PAYMENT'` plus atomic `updateMany` with `where: { id, status: 'PENDING_PAYMENT' }`. Count=1 wins → side effects fire once; count=0 → silent ack. **Verify:** force Stripe webhook redelivery; expect single invoice email, no duplicate notifyAdmins.

### BUG-003 · FIX_IN_PROGRESS · currency-aware notification
`src/app/api/stripe/webhook/route.ts` — uses `Intl.NumberFormat` with order's currency. Cart `checkoutCart` and single `startCheckoutWithAddress` still hardcode €; queued. **Verify:** USD order → notification shows "$" not "€".

### BUG-004 · FIX_IN_PROGRESS · deleteProduct routes to ARCHIVE on order history
`src/app/app/seller/products/actions.ts` — `prisma.orderItem.findFirst({ where: { productId } })` blocks hard-delete; auto-archives instead. **Verify:** seller deletes a product with order history → status flips to ARCHIVED, FK relations preserved.

### BUG-009 (RB) · FIXED (code; browser-unverified — reconciled 2026-06-07) · Fulfillment server-guard against no-address orders
`src/app/admin/actions.ts setOrderFulfillment` + `bulkMarkAllShipped` — `shippingAddressIsComplete()` helper checks name/line1/city/postal/country(2-letter). SHIPPED/DELIVERED throw if missing; bulkship filters and reports skipped. **Verify:** attempt to mark address-less order SHIPPED via single + inline + bulk → expect rejection with clear message.

### BUG-010 (RB) · FIXED (code; browser-unverified — reconciled 2026-06-07) · setOrderFulfillment idempotent (kills audit ×17)
`src/app/admin/actions.ts` — pre-check `statusUnchanged && carrierUnchanged && trackingUnchanged` → no-op early. Status transition wrapped in `updateMany` with `where: { status: order.status }` precondition; lost race = silent skip. **Verify:** double-click the Save button on order detail → expect ONE audit row, ONE notification, ONE email, not 17.

---

## OPEN (RB-LEVEL — added from browser audit)

### BUG-011 · P0 · FIXED (code; browser-unverified) · RB-GATE · Checkout-cart path can create address-less orders when Stripe is off

> **2026-06-01 reconcile:** fix is present in the working copy (verified by code
> read this round). The stale "OPEN" header was corrected — same pattern as
> BUG-001/002/004 in prior rounds.
> - `src/lib/cart/actions.ts` `checkoutCart()` is now a thin redirect to
>   `/checkout/cart` (the address-collection page); the old direct order-create
>   entrypoint is gone.
> - `startCartCheckoutWithAddress(formData)` collects + server-validates a full
>   shipping address (name/phone/line1/city/postal/2-letter country), atomically
>   reserves stock with rollback, then creates the order **with** a populated
>   `shippingAddress` JSON — so the address-less PENDING_PAYMENT class can no
>   longer be created through the cart path.
> - `src/app/checkout/cart/page.tsx` renders the form with bank-transfer copy
>   only ("No charge is taken at this step"); **no Stripe / card / "pay now"
>   wording** — manual-payment posture preserved. Future-Stripe handoff
>   (`_legacyStripeCartHandoff`) is kept but gated behind `stripeConfigured()`.
> Awaiting browser re-verify (add cart item → /checkout/cart → submit with a
> missing field → expect inline "Please fill in" + no order; then complete →
> expect PENDING_PAYMENT order WITH address + success?pending=1).

**Files:** `src/lib/cart/actions.ts:110-148` (no-STRIPE branch)

**Symptom:** When `stripeConfigured() === false` (current production posture per audit), `checkoutCart` creates the order with no `shippingAddress`. Order then sits in PENDING_PAYMENT awaiting manual payment, but warehouse can't ship.

**Root cause:** Cart flow delegates address collection entirely to Stripe's `shipping_address_collection`. Bypassed when Stripe is off.

**Fix (requires UI):** Add `/checkout/cart` address form mirroring `/checkout/[slug]`. Server action: collect address → reserve stock → create order with `shippingAddress`. Same form serves both stripe-on and stripe-off.

**Stop-gap (deployed):** server-guard at SHIPPED/DELIVERED transition (BUG-009) catches downstream. Source still needs closing.

---

### BUG-012 · P1 · FIXED (code; browser-unverified) · UX/Stability · /admin Overview hydration mismatch (React #418/#423/#425)
**Symptom:** Cold load of `/admin` intermittently throws hydration mismatch from server-rendered live timestamps + relative "Xd ago" strings (server TZ ≠ client TZ).

**Fix:** Wrap timestamps with `suppressHydrationWarning`, OR render time-dependent text via `useEffect` after mount. Will hunt down the components after locating the Overview server component.

> **2026-05-31 resolution.** `/admin` (`src/app/admin/page.tsx`) is a pure Server
> Component (verified: no `'use client'`; Charts are server-rendered SVG; only
> `BulkShipButton` is a client island and it renders NO time). The `timeAgo()` helper
> is pure integer arithmetic (`nowMs - d.getTime()` → "2h"/"3d") and is **timezone-
> independent**, so it cannot drift SSR↔client. The single genuinely TZ-dependent
> output was `lastRefreshed` via `toLocaleTimeString` with **no `timeZone`**, which
> silently rendered the SERVER's clock to every viewer. Two-part fix:
> 1. The `suppressHydrationWarning` wrappers around `lastRefreshed` and the relative-
>    time KPI `sub` were already in place (prior round) — kept as defence-in-depth.
> 2. **New this round:** pinned `lastRefreshed` to `timeZone: 'UTC'` + ` ' UTC'` label
>    so the value is deterministic (no SSR/client drift) AND honest (no longer shows
>    server-local time mislabelled as the viewer's). This also removes a real
>    correctness/confusion bug, not just the hydration warning.
>
> Browser re-verify: cold-load `/admin` from a non-server TZ, confirm no React
> #418/#423/#425 in console and the "refreshed … UTC" label renders.

---

### BUG-013 · P0 · OPEN · RB-GATE · Stripe not configured on production (HARD GATE)
**Symptom:** Audit found `STRIPE SESSION —` and `PAYMENT INTENT —` on every order; admin UI says "lab2date Stripe account (not configured)". All money flows through manual `markOrderPaidManually`.

**Resolution required from user:**
- (A) Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` on production, connect Stripe webhook endpoint `/api/stripe/webhook`, run test charge. Then orchestrator validates webhook idempotency fix (BUG-002) end-to-end.
- (B) Officially launch with manual-payment posture. Then: harden the manual flow (already mostly done), document the operational SLA, and remove the now-dead Stripe code paths from launch checklist.

---

### BUG-014 · P1 · FIXED (code; browser-unverified) · Reporting · Payment method shows "—" despite verified BANK_TRANSFER orders
**Symptom:** Audit shows verified bank-transfer orders display `payment.method = "—"` in reports.

**Root cause hypothesis:** `paymentMethodManual` (manual flow) is populated but reports query `paymentMethodBrand` (Stripe-only). Need to read both and prefer `paymentMethodManual` for manual-paid orders.

**Fix:** Locate report renderer, fold both columns into a single display. SQL backfill proposed in audit awaits user OK (task #17).

> **2026-05-31 resolution.** Audited every payment-method render site:
> - `src/app/admin/orders/[id]/page.tsx` — `paymentLabel(brand,last4,wallet,manual)`
>   already falls back to `manual` then "—". ✅ correct.
> - `src/components/admin/OrderQuickView.tsx` — same `paymentLabel` helper. ✅ correct.
> - `src/app/admin/actions.ts` — order export already passes `paymentMethodManual`
>   through to the client shape. ✅ correct.
> - **`src/app/admin/orders/[id]/invoice/page.tsx` — THE STALE RENDERER.** It read
>   only `order.paymentMethodBrand` and printed *"not yet captured"* for manual-paid
>   orders. **Fixed:** added a `: order.paymentMethodManual ? (BANK TRANSFER) :` branch
>   so verified manual orders show their method on the invoice/report.
>
> No SQL backfill needed — the data (`paymentMethodManual`) was already persisted
> correctly by `markOrderPaidManually`; this was purely a display/read bug. The
> proposed destructive backfill (task #17) can be dropped.
>
> Browser re-verify: open a verified BANK_TRANSFER order's invoice page → expect
> "Method: BANK TRANSFER", not "not yet captured" / "—".

---

## VERIFIED (by browser audit — kept as regression evidence)

- ✅ Quote→proforma→accept→order→paid chain (PRO-2026-UTZOJ2)
- ✅ Payment proof → admin verify → PAID → ship attribution (L2D-2026-OVTULH)
- ✅ Buyer sees tracking after SHIPPED + "Mark as received" (L2D-2026-ZXIDTU)
- ✅ Buyer horizontal access control: own=200, other=404 ×2
- ✅ Admin invoice/proforma render; auth-gated
- ✅ All admin surfaces load; server errors log clean

---

## UNVERIFIED — blocked on missing sessions (task #16)
- RB-1 message attribution (need buyer-only session)
- W seller scoping (need seller-only session; Phase 5/6 stubs may need build-out)
- G no order before accept
- K AWAITING_VERIFICATION not PAID
- L admin views proof file
- O stock decrement baseline
- Y random user / anonymous access

---

## Batch log — 2026-05-29 (round 2, post-incident resume)

Incident from round 1 (Edit-tool truncation) is **RESOLVED**: `src/app/admin/actions.ts`
(2604) and `src/lib/cart/actions.ts` (267) were restored to their healthy
post-fix baselines and `tsc --noEmit` exits 0. All round-1 P0 fixes verified
present in source: BUG-001 (publishProduct gate), BUG-002 (webhook idempotency +
Intl currency), BUG-004 (deleteProduct→ARCHIVE), BUG-011 (cart address gate +
`checkout/cart/page.tsx`).

**A second truncation occurred this round** on `src/lib/orders/actions.ts` when an
Edit-tool full-file rewrite was cut at ~432 lines mid-catch-block. Recovered the
lost tail faithfully from the compiled bundle `.next/server/chunks/4952.js` and
re-wrote it via the shell (append), NOT the Edit tool. Lesson locked in: **for
large `.ts` files, write through the shell and `tsc` after every change.**

Resolved this round (code-level; NOT browser-verified — Chrome perm for
labtodate.com still not granted):

- **BUG-003 → FIXED.** Last hardcoded `€` removed from `orders/actions.ts`
  single-product `startCheckoutWithAddress` notifyAdmins; now currency-aware via
  `Intl.NumberFormat(product.currency)` with a plain-format fallback. Webhook and
  cart paths were already currency-aware. Invariant **F13 closed at code level.**
- **BUG-007 → FIXED.** Added an orphaned-`PENDING_PAYMENT` janitor to the
  `sla-sweep` cron. Cancels stale unpaid orders and releases reserved stock.
  Manual-payment-safe: generous TTL (`ORPHAN_ORDER_TTL_MINUTES`, default 7 days),
  and only touches orders with no Stripe session, no `paymentSubmittedAt`, no
  `paymentVerificationStatus`, and no linked `sourcingRequestId`. Race-safe atomic
  `updateMany` guarded by `status:'PENDING_PAYMENT', paymentSubmittedAt:null`; only
  the winner releases stock. Idempotent (CANCELED rows fall out of the WHERE).
- **BUG-008 → FIXED.** Already satisfied in restored `cart/actions.ts`: the cart
  `notifyAdmins` passes `'ORDER_NEW'` as the 4th arg. Verified, no change needed.
- **BUG-006 → FIXED.** `minPasswordLength` 8 → 12 in `auth.ts`. Affects only
  newly-set passwords (sign-up / reset); existing users are not locked out.
  Complexity-character rule deferred (Better-Auth needs a Zod wrapper) — left as
  a P3 follow-up, not a blocker.

Still BLOCKED:

- **BUG-005 (email verification) → BLOCKED.** Flipping `requireEmailVerification:
  true` is unsafe as-is: there is **no `emailVerification.sendVerificationEmail`
  handler** configured in `auth.ts`, and `requireEmailVerification` has always been
  false, so existing users are almost certainly `emailVerified:false`. Flipping the
  flag would (a) send no verification email to new sign-ups and (b) block password
  sign-in for the entire existing user base until they verify. **Needs from user:**
  a rollout decision — confirm prod email delivery is reliable, decide whether to
  backfill existing accounts as verified (or rely on magic-link), then I'll wire
  `sendVerificationEmail` + flip the flag behind that backfill. Not done autonomously.

---

## Browser audit — 2026-05-29 (REAL session, admin: Hossein Hashiri / iceberg.rig@gmail.com)

Live site exercised with a real Chrome session. Evidence = screenshots + network
log + visual inspection. Console-message capture was unreliable this pass
(tool returned "no messages" repeatedly), so hydration is "observed-clean,
NOT certified". Authenticated session is the user's own ADMIN account; no
state-changing actions were taken (no orders/quotes/tickets/messages created).

### Verified (read-only, real navigation)
- Homepage `/` → 200, renders, featured listings + stats present.
- Product detail `/marketplace/ab-sciex-qtrap-5500-lc-ms-system` → **full nav 200**,
  renders ("Quote only" product, Request-a-quote CTA). No buy/cart button (quote flow).
- `/app/cart` → full nav 200, "Your cart is empty" renders.
- `/admin` Overview → 200, renders; "live · refreshed HH:MM:SS" timestamp shows
  with no visible hydration crash → **BUG-012 fix appears to hold** (observed, not certified).
- `/admin/orders` → 200, 11 orders render with status facets.

### NEW BUG-015 · P1 · FIXED (config; deploy+browser-unverified) · Reliability/Perf · RSC prefetch returns 503 site-wide
**Symptom:** Next.js RSC prefetch requests (`?_rsc=…`) return **503** while the
identical route returns **200** on full navigation. Reproduced on:
`/app/cart?_rsc=` (503 ×2, two tokens), `/marketplace/ab-sciex-qtrap-5500-lc-ms-system?_rsc=` (503),
homepage-triggered prefetch of `/app/cart` (503). Full navigations of all these → 200.
**Impact:** `<Link>` prefetch is broken → no instant client nav (falls back to full
load), and every hovered link emits a 503 server error (noise, possible alarm
fatigue / masks real 503s). Likely an infra/runtime cause: the standalone server,
CDN, or middleware rejecting requests carrying the `RSC`/`Next-Router-Prefetch`
header. **Next step:** check middleware.ts matcher + reverse-proxy/CDN rules for
`_rsc`/`RSC` header handling; reproduce against the standalone server directly.
**Status:** code-level not yet diagnosed; needs server/infra log correlation.

### NEW BUG-016 · P2 · FIXED (config; deploy+browser-unverified) · Content · Blog cover images 403
**Symptom:** `/media/lab2date-media/blog-cover/centrifuge-rotor-compatibility-guide.jpg`
and `…/mass-spec-cost-breakdown-2026.jpg` return **403** (homepage/blog references).
**Impact:** broken blog cover images. **Next step:** check media bucket ACL / the
`/media/*` route handler auth for public blog assets.

### Evidence for legacy bad data (pre-existing; fixes prevent NEW occurrences)
- Order **L2D-2026-TATSIL** (€12,345, customer Hossein Hashiri) shows status
  **DELIVERED** with an **empty fulfilment column ("—")** — no carrier/tracking.
  This is exactly the address-less / fulfilment-less record class BUG-009 now
  blocks going forward. The historical row still exists → candidate for the
  cleanup SQL (needs user approval before any mutation).

### Could NOT verify this pass — needs credentials / permission (NOT done autonomously)
- **B1 sign-up** — account creation is prohibited for the agent.
- **B7** buyer-cannot-read-another-buyer's-order — needs a BUYER (non-admin) session.
- **B8/B9** seller publish / cross-seller edit — needs a SELLER (non-admin) session.
- **B10** admin-without-cap refund → forbidden — needs a limited-cap admin.
- **B11** duplicate-submit checkout — creates real orders → needs permission + test product.
- **B6** payment-proof upload, **quote/ticket/chat create**, **admin verify→PAID** —
  all create/modify real production data → need explicit per-action permission.
- **B14–B17** sign-out/magic-link/password-reset/suspended-sign-in — require
  signing out the user's only live session and inbox access → not done (would
  strand the session; agent cannot re-enter passwords).

### BUG-015 — DIAGNOSIS UPDATE (confirmed via browser probing)
**Confirmed: infra-layer, load-dependent. NOT an app bug, NOT route-specific.**
Evidence:
- Same route flips status across prefetch batches: `/legal/cookies` 200 then 503;
  `/` 200 (`qbm21`) then 503 (`g22tz`); `/marketplace` 200 then 503.
- 503 rate scales with batch size: 12-request batches lost ~2; a 20-request batch
  (`g22tz`) lost ~10. Single sequential `_rsc` fetch → 200 (`text/x-component`).
- A manual burst of 14 concurrent fetches to ONE route → all 200 (cheap/cached);
  the real homepage fires 12-20 DISTINCT dynamic SSR routes at once → fraction 503.
- Front proxy is **nginx/1.26.3 (Ubuntu)** (no Cloudflare; `cf-ray`/`via` absent).
  No 503-emitting code exists anywhere in `src/`.
**Root cause (high confidence):** the Next.js standalone upstream (single process)
saturates under a burst of concurrent server-component renders; nginx returns 503
for the connections it can't proxy. **Impact:** `<Link>` prefetch unreliable →
degraded perceived navigation + 503 log noise. **Not** a data/correctness blocker.
**Fix (infra, on deploy host — not in repo):**
- nginx upstream keepalive: `upstream web { server 127.0.0.1:3100; keepalive 64; }`
  + `proxy_http_version 1.1; proxy_set_header Connection "";`. Raise
  `worker_connections`. Check for any `limit_conn`/`limit_req` zone whose
  `*_status` is 503 and relax/exclude `_rsc` GETs.
- Scale the Next standalone (run 2-4 replicas behind nginx) so concurrent SSR
  renders don't queue behind one event loop; OR add micro-cache for `_rsc` GETs
  of public routes; OR reduce homepage Link `prefetch` pressure.
Reclassified **P1 → reliability/perf**, infra owner. App code unchanged.

### BUG-016 — DIAGNOSIS UPDATE (confirmed)
Fetch of `/media/lab2date-media/blog-cover/mass-spec-cost-breakdown-2026.jpg`
returns **403** with a MinIO XML body: `<Code>AccessDenied</Code>
<Key>blog-cover/mass-spec-cost-breakdown-2026.jpg</Key>` (served via nginx).
So the `/media/:path*` → MinIO rewrite resolves correctly, but the
`lab2date-media` bucket has **no anonymous-read policy** for the `blog-cover/`
objects (or the objects are missing). External product images (lab2.nl,
conquerscientific.com) load fine — only self-hosted MinIO blog covers 403.
**User impact: low/cosmetic** — the blog grid degrades gracefully to designed
gradient placeholders (no broken-image icons). **Fix (infra):** set a
public download policy on the `lab2date-media` bucket / `blog-cover/*` prefix
(`mc anonymous set download …`), or re-upload the missing covers, or serve
blog media through the authenticated `/media` proxy with a public exception.
**P2 cosmetic**, infra owner.

---

## Browser-VERIFIED E2E (real prod session, TEST data, cleaned up) — 2026-05-29

> These ARE marked VERIFIED: a real browser session exercised them end-to-end on
> the currently-deployed build, with TEST data (QA-E2E prefix) and cleanup proof.

### ✅ VERIFIED — Sourcing / quote intake → admin → SLA → archive
Submitted `/let-us-find-it` as QA-E2E TEST → 303 → `/let-us-find-it/thanks?id=…`.
Appeared in `/admin/quotes` as **RFQ-5AF2X4** (WAITING FOR SUPPLIER, 24h SLA,
unassigned). Archived for cleanup. **Cleanup proof:** Open 2→1, Archived 3→4,
row removed from Open queue.

### ✅ VERIFIED — Support ticket intake → admin → notification → staff reply → archive
Submitted `/support` as QA-E2E TEST → 303 → `/support/thanks?ref=TKT-2026-7VVTQU`.
- Appeared in `/admin/tickets` (TECHNICAL, AWAITING REPLY, 24h SLA).
- **Real-time admin notification fired** (live "NEW EVENT" toast + bell badge) → **N3 VERIFIED**.
- Posted staff reply → conversation 1→2 msgs, status auto **support→"waiting on
  customer"**, timeline "Last reply: support …" → **S6 VERIFIED** — and emailed buyer.
- Archived for cleanup. **Cleanup proof:** header badge ARCHIVED + button→Restore.

### BUG-014 — browser-CONFIRMED + defended (display was never the bug)
On real order `L2D-2026-TATSIL` (DELIVERED, paid via "Payment received"): Payment
**METHOD "—"**, STRIPE SESSION "–", PAYMENT INTENT "–", origin "From accepted quote".
- **Both display renderers are already correct** (`paymentLabel(...)` in
  `admin/orders/[id]/page.tsx` and `OrderQuickView.tsx` both read+show
  `paymentMethodManual`). So "—" = a *data* gap, not a render bug.
- Live paths persist the method (`markOrderPaidManually`, `buyerSubmitPaymentProof`);
  the quote-accept path creates PENDING_PAYMENT (no bypass). TATSIL "—" is legacy data.
- **Fix applied (defensive):** `verifyPayment` now writes
  `paymentMethodManual: order.paymentMethodManual ?? 'BANK_TRANSFER'`, so a verified
  manual order can never render "—" going forward. Status: FIXED in working copy
  (UNVERIFIED until deploy). Legacy "—" rows = cleanup-SQL candidates (needs approval).

### NEW BUG-017 · P2 · FIXED(wc) · Manual-posture copy · "Deposited into: Stripe account" on manual orders
`admin/orders/[id]/page.tsx` showed **"lab2date Stripe account (not configured)"**
in the "Deposited into" field even for manual bank-transfer orders — misleading ops
copy that conflicts with the no-fake-Stripe-wording rule. **Fix:** when Stripe is not
configured, render **"Manual settlement · bank transfer (no Stripe)"**; Stripe wording
only when a real key is present. FIXED in working copy (UNVERIFIED until deploy).

### Legacy data confirmed (cleanup-SQL candidates; needs user approval — NOT touched)
- `L2D-2026-TATSIL`: DELIVERED with **"No address captured"** + payment METHOD "—".
- Multiple orders with junk addresses ("sdvsdv…NL", Arabic placeholder) + junk tracking.
- These are exactly what `scripts/cleanup-dry-run.sql` targets.

---

### NEW BUG-018 · P1 · FIXED(wc) · Business-logic · Customer reply on an ARCHIVED ticket/quote stays hidden (lost message)
**Browser-CONFIRMED on prod (2026-05-29) with TEST data.**
Repro: admin archives ticket `TKT-2026-7VVTQU` → buyer replies from `/app/support`
→ a "Customer replied" toast fires, BUT the ticket does **NOT** return to the
admin **Open** queue (Open showed **0 / "No tickets match this view"**); it stays
in **Archived**. An admin working the queue never sees the waiting customer → the
reply is effectively a lost customer message. Same flaw for quotes
(`replyToQuote`, buyer path) — an archived quote stays archived on buyer reply.
**Root cause:** `customerReplyTicket` set `status: WAITING_ON_SUPPORT` but never
cleared `archivedAt`; `replyToQuote` likewise never cleared `archivedAt` on a
buyer reply.
**Fix (working copy):**
- `src/lib/support/actions.ts` `customerReplyTicket`: now also sets
  `archivedAt: null, archivedById: null` — a customer reply resurfaces the ticket.
- `src/lib/quotes/actions.ts` `replyToQuote`: when `!fromStaff`, also clears
  `archivedAt/archivedById` so a buyer reply resurfaces the quote.
Status: FIXED in working copy, type-clean. UNVERIFIED until deploy.

### NEW BUG-019 · P2 · SUPERSEDED→FIXED · UX/Business-logic · Admin "Archive" gives no buyer-facing closure
> **2026-07-09 reconcile:** this stale "OPEN" header is superseded by the FIXED
> entry lower in this file ("BUG-019 · P2 · FIXED (code; browser-unverified) ·
> Buyer-facing closure for archived-but-unresolved tickets/quotes"). Fix is in
> the working copy (computeDealState archivedAt → lost_closed / "Closed by our
> team"). Still browser-unverified (gated on BUG-033). No new OPEN, non-blocked
> code item exists as of this run.
Archiving a ticket/quote in admin hides it from the admin queue but the buyer
keeps seeing it as active ("Awaiting your reply" / "WAITING FOR SUPPLIER")
indefinitely. Archive is operator-only by design, but using it as a substitute
for resolution leaves the buyer hanging. **Recommendation:** archiving an
unresolved ticket/quote should either prompt to set a terminal status
(RESOLVED/CLOSED/LOST) or surface a buyer-facing "closed" state. Low data risk,
real UX/trust gap. (Now partially mitigated by BUG-018: a buyer reply at least
pulls it back into the queue.)

---

## Admin tab-by-tab sweep — 2026-05-29 (all ~20 tabs, real session)
All admin tabs render 200 with no visible crash: Overview, Orders, Quotes,
Tickets, Acquisitions(`/admin/sell`), Messages, Products, Brands, Categories,
Users, Shops&suppliers(`/admin/companies`), Blog, Wiki, Testimonials,
Case-studies, Lab-rental, Announcements, Homepage, Settings, Analytics.
RSC-503 (BUG-015) recurred on prefetches for `/admin/sell`, `/admin/homepage`,
`/app/support` — consistent with the load-dependent diagnosis.

### NEW BUG-020 · P2 · OPEN · Config/Deliverability · Notification inboxes mis/unset
From `/admin/settings` → Email:
- **Sell submissions go to `acquisitions@lab2date.local`** — `.local` is not a
  deliverable domain; "sell your equipment" notification emails will bounce/never arrive.
- **Quote requests inbox = "Not set"** (`QUOTE_INTAKE_EMAIL` empty) → quote-intake
  emails fall back to a generic default instead of a dedicated queue.
- From-address is `support@labtodate.com`; real delivery needs the Resend domain
  verified for `labtodate.com` (couldn't verify deliverability from browser).
Fix is config (Settings), not code — left for the owner; flagged as P2.

### Hygiene notes (data, not code) — for cleanup decision (needs approval)
- Prod has a likely **test ADMIN account** `hoseinhashiri@gmail.com` (role admin)
  and a near-duplicate `iceberg.ri@gmail.com` (admin). Minimizing admin count is
  a security best-practice. (No role change made — prohibited on real users.)
- Leftover **E2E test buyers** in prod: `e2e-sv-*`, `e2e-ai2-*`, `e2e-admin-*`
  `@lab2date-e2e.local`, plus `diag-full-*@lab2date.test`. Cleanup candidates.
- Empty category **"Microscopy & Imaging" (0 products)** is still surfaced in
  marketplace category filters — minor UX (shows an empty category).

### Safety holds observed (did NOT trigger)
- Announcements "Send to users" = mass notify+email to 22 real users, irreversible — not clicked.
- Users "Set role" inline dropdowns — not changed (prohibited on real users).
- Shops Verify/Block/Feature, Settings edits — not changed.

---

### NEW BUG-021 · P0 · UNVERIFIED_ON_PROD · Revenue-blocking · Quote→order dead-ends for the buyer
**Browser-CONFIRMED on prod (2026-05-29).** Full repro with TEST data:
1. Buyer submits sourcing request (`/let-us-find-it`) — OK.
2. Admin issues a proforma (`PRO-2026-O7LHKN`, €1) — OK, lifecycle reaches PROFORMA.
3. **Buyer is now stuck.** The buyer quote page (`/app/quotes/<id>`) at the PROFORMA
   stage shows only **"Send reply"** and **"Decline"** — there is **NO "Accept" /
   "Pay" / "Complete purchase" action**, and on the deployed build **no order is
   materialized** (admin LINKED COMMERCE = "Quote sent: €1", no order; admin Orders
   PENDING PAYMENT = 0). Net: a buyer who receives a proforma has no in-app path to
   pay → the primary revenue path (quote→order→pay) is broken on production.

**Mechanism:** `src/app/app/quotes/[id]/page.tsx` only renders the
"Complete your purchase" CTA (→ `/app/orders/<num>/payment`) when a `linkedOrder`
with status `PENDING_PAYMENT` exists. The deployed build does not create that
order at proforma-send, and the old "Accept" button has been removed from the
buyer UI → the buyer is dead-ended.

**Fix:** already present in the working copy — `src/lib/quotes/actions.ts`
`replyToQuote`/proforma path **materializes the Order (PENDING_PAYMENT) at
proforma-send time** when `sr.submittedById` is set, and emails a payment-workspace
CTA. Once deployed, the buyer quote page renders "Accepted — order … · awaiting
your payment" + "Complete your purchase", and the flow proceeds to
proof→verify→ship→deliver. **Status: fix in working copy; UNVERIFIED_ON_PROD until
deploy** (cannot verify downstream on prod because the deployed build won't create
the order, and the catalog is 100% quote-only so there's no cart fallback).

**Consequence for this audit:** the full order/payment/fulfillment E2E
(proof upload → admin verify → stock → ship → deliver) is **BLOCKED on prod** by
BUG-021 — no payable order can be created on the deployed build through any path.
Upstream verified: quote intake ✅, proforma issuance ✅, notifications ✅.
Downstream stays UNVERIFIED_ON_PROD pending deploy of the working-copy fix.

---

## RECLASSIFICATION (discipline pass — verify intended model before P0/P1)

### BUG-021 — RECLASSIFIED: NOT a bug → DEPLOYMENT GAP / NEEDS-PRODUCT-CONFIRMATION (was wrongly P0)
Correction: I over-classified this as a "P0 revenue-blocking bug" by assuming an
in-app **Accept/Pay** step is mandatory. It is not an established product requirement.
- **Implemented (verified in code):** `submitSourcingRequest` sets `submittedById`
  for logged-in users. Order creation has TWO paths: `setQuoteStatus('ACCEPTED')`
  (older, buyer-Accept→order) and `replyToQuote` proforma-send auto-materialize
  (newer, in working copy). Deployed build: buyer UI hides Accept; backend did not
  auto-materialize at proforma-send.
- **Intended model (evidence):** proforma copy states "not a demand for payment …
  reply to proceed and we will issue payment instructions"; official posture is
  **manual bank-transfer**, admin marks orders paid (`markOrderPaidManually`). All
  9 existing paid orders flowed through this manual/concierge path. **Revenue is
  NOT blocked** — the team processes payment manually.
- **Correct label:** *Deployment gap / version skew* — the self-serve buyer-payment
  workspace (auto-materialize order at proforma-send + "Complete your purchase" CTA)
  is staged in the working copy but not deployed, while the deployed UI already
  hides the old Accept button. Whether self-serve buyer payment is a requirement at
  all is a **product/business decision** to confirm with the owner — NOT a defect.
- **Severity:** downgraded from P0 to **P3 / needs-product-decision**. No code change
  asserted as a "fix" for a bug; the working-copy materialize-at-proforma logic is a
  *feature in progress*, not a regression patch.

### BUG-018 — severity nuance
On a customer reply to an archived ticket, a real-time admin notification DOES fire
("Customer replied"), so the message is not strictly lost — ops is alerted. The gap
is only that the ticket doesn't re-enter the Open *queue*. So this is better framed
as a **P2 UX/workflow improvement** (queue should reflect the reactivation), not a
P1 "lost message". The working-copy auto-unarchive remains a reasonable, low-risk
improvement, but it is an enhancement, not a critical-defect fix. Re-labeled P2.

### Method note (applies going forward)
Before any P0/P1: (1) verify implemented flow in code, (2) verify intended flow from
product copy/requirements, (3) classify as bug / missing-feature / business-decision
/ deployment-gap. Do NOT invent mandatory steps (Accept, Checkout, Stripe, Cart,
Auto-Order) absent explicit requirements.

---

## NEW — 2026-06-01

### NEW BUG-022 · P1 · FIXED (code; browser-unverified) · Financial/State-integrity · Refunded/canceled orders could be re-fulfilled (F12 / S3)
**File:** `src/app/admin/actions.ts` — `setOrderFulfillment`

**Symptom (found by code read this round):** `setOrderFulfillment` enforces
address-completeness (BUG-009), idempotency + a no-op fast path (BUG-010), and an
atomic transition via `updateMany({ where: { id, status: order.status } })`. But
that precondition only asserts *the status hasn't changed concurrently* — it does
**not** assert the order isn't already in a terminal money-state. So an admin (or a
stale/duplicate form submit, or a crafted POST) could move an order that is already
**REFUNDED** or **CANCELED** straight to **PROCESSING / SHIPPED / DELIVERED**: the
`where` clause matches (`status === order.status === 'REFUNDED'`), the row updates,
and the buyer is told their refunded order shipped.

**Impact:**
- Goods dispatched against money already returned (refunded) → direct financial loss.
- A canceled order silently resurrected into an active, shippable state.
- Buyer gets a "your order has shipped" email/notification for a refunded order →
  trust + support fallout.
- Violates invariant **F12** ("refunded order doesn't allow re-fulfilment", was ⏳)
  and the spirit of **S3** (monotonic status transitions).

**Root cause:** No terminal-state check before the transition. Refund and cancel
have dedicated actions (`refundOrder`, `cancelOrder`) that own those transitions and
the stock restock; `setOrderFulfillment` had no symmetric guard preventing exit from
them.

**Fix (working copy):** Added an early guard after the order fetch:
```
const TERMINAL_ORDER_STATES = new Set(['REFUNDED', 'CANCELED']);
if (TERMINAL_ORDER_STATES.has(order.status) && status !== order.status) {
  throw new Error(`Cannot change order … to … — it is … (terminal). Refunded or
                   canceled orders cannot be re-fulfilled.`);
}
```
Same-status edits (e.g. attaching tracking notes to a refunded row) remain allowed;
only a status **change** out of a terminal state is rejected. Scope kept tight — no
broader S3 monotonicity rewrite (no drive-by refactor). DELIVERED→backwards and full
forward-only monotonicity remain a separate, lower-risk follow-up.

**Manual-payment posture:** unaffected — no Stripe/card/pay-now wording; the dedicated
manual refund/cancel paths are untouched.

**Verify (browser, when a session is available):** on a REFUNDED test order, attempt
to set SHIPPED via the order-detail Save and via the inline tracking field → expect
a clear rejection, status stays REFUNDED, no "shipped" email. Repeat on a CANCELED
order. Confirm a normal PAID→PROCESSING→SHIPPED→DELIVERED order is unaffected.

---

## NEW — 2026-06-07 (round: invariant code-verification sweep)

> Round summary: BUG-009/010 stale headers reconciled (fixes confirmed in
> `src/app/admin/actions.ts` by code read). Chrome was NOT connected this run —
> no browser verification possible; all statuses below are code-level only.
> Two Edit/Write-tool truncation incidents occurred (marketplace/[slug]/page.tsx
> tail, auth route file) — both fully recovered (tail restored from git HEAD,
> file rewritten via shell) and `tsc --noEmit` exits 0. Lesson re-confirmed:
> write large/new files through the shell, `tsc` after every change.

### NEW BUG-023 · P0 · FIXED (code; browser-unverified) · Financial/State-integrity · Re-issuing a proforma rewrote money fields of an already-PAID order
**File:** `src/lib/quotes/actions.ts` — `sendProforma`

**Symptom (found by code read):** when a quote already had a materialized order,
`sendProforma` ran `prisma.order.update` on it **unconditionally** — no status
precondition. Re-issuing a proforma at a new price after the buyer had paid
(or after refund/cancel) silently rewrote `subtotalCents/shippingCents/taxCents/
totalCents/currency` on the PAID/terminal order → paid amount ≠ order total,
reconciliation breakage. Secondary gap: on a legitimate pre-payment re-issue,
order totals changed but the single `OrderItem.priceCentsSnapshot` did not →
`totalCents ≠ Σ items` (invariant F1 violation).

**Fix (working copy):**
1. Early **freeze guard** (before any write, so rejection leaves no partial
   state): if the linked order has left PENDING_PAYMENT and the new price or
   currency differs, throw with a clear message ("refund/cancel first or open a
   new quote"). Identical-price resend (document/email duplication) stays allowed.
2. Totals rewrite now atomic `updateMany({ where: { id, status: 'PENDING_PAYMENT' } })`
   — a concurrent payment wins the race and freezes the amounts.
3. When the rewrite succeeds (count===1), the quote line's `priceCentsSnapshot`
   is synced to the re-issued price so F1 holds pre-payment (snapshot freezes at
   payment, not at first issuance).

Manual-payment posture untouched; bank-transfer wording only.

**Verify (browser, when session available):** issue proforma → buyer pays →
admin verifies (PAID) → re-send proforma at a different price → expect rejection,
order totals unchanged. Re-send at same price → succeeds (email only). Pre-payment
re-issue at new price → order totals AND item snapshot both update.

### NEW BUG-024 · P2 · FIXED (code; browser-unverified) · Security/Privacy · ARCHIVED/DRAFT/PENDING_REVIEW products publicly viewable by direct URL (invariant S10)
**File:** `src/app/marketplace/[slug]/page.tsx`

**Symptom:** every public listing/search/sitemap query correctly filters
`status='PUBLISHED'`, but the product **detail page** had no status gate —
anyone with (or guessing) a slug could view archived/unreviewed products,
re-opening the admin-review bypass surface BUG-001 closed (an unapproved
product was reachable by URL even though unlisted). `generateMetadata` also
leaked titles of non-public products.

**Fix:** non-PUBLISHED → `notFound()` (same contract as `/checkout/[slug]`),
EXCEPT the owning seller and ADMINs, who may still open the page as a preview.
Metadata returns "Not found" for non-PUBLISHED regardless (cosmetic for
owner-preview, prevents the leak).

**Verify:** as anonymous, open an ARCHIVED product URL → 404; as the owning
seller → renders; listing pages unaffected.

### NEW BUG-025 · P1 · FIXED (code; browser-unverified) · Security · No rate-limiting on sign-in / sign-up / forgot-password (invariant A14)
**File:** `src/app/api/auth/[...all]/route.ts`

**Symptom:** `lib/ratelimit.ts` exists and is wired into uploads, tickets,
quotes, sell & blog actions — but **not** into any auth endpoint. The auth
route was a bare `toNextJsHandler` delegation: unlimited credential stuffing,
email enumeration, sign-up spam, and email bombing via magic-link /
forgot-password.

**Fix:** POST handler now applies per-IP sliding-window limits to the
credential-sensitive paths only (sign-in 10/15min, sign-up 5/h, forgot/reset
password 5/15min, magic-link 5/15min) → 429 with a Better-Auth-compatible
`message` body. GET and non-sensitive POSTs (session refresh, callbacks,
sign-out) untouched. In-memory limiter matches the existing single-instance
deployment posture (same as every other rateLimit call site).

**Verify:** 11 rapid failed sign-ins from one IP → 11th returns 429; normal
sign-in unaffected; sign-out/session refresh never throttled.

## NEW — 2026-06-08 (round: S3 monotonicity hardening)

> Round summary: Chrome NOT connected this run — no browser verification
> possible; all statuses below are code-level only. `npx tsc --noEmit` exits 0.
> One Edit-tool truncation incident occurred and was fully recovered (see note
> at end of this section). Highest-priority unblocked item this round was the
> documented S3 follow-up (the only release-blocking invariant still 🟡 that is
> not waiting on user/infra input). BUG-013/005/015/016/020 remain BLOCKED
> (Stripe creds / email-verification rollout decision / infra / config).

### NEW BUG-026 · P1 · FIXED (code; browser-unverified) · State-integrity · setOrderFulfillment allowed illegal (backward / skip-payment) status transitions (invariant S3)
**File:** `src/app/admin/actions.ts` — `setOrderFulfillment`

**Symptom (found by code read + UI read):** the fulfilment `<select>` on both
the order-detail page (`admin/orders/[id]/page.tsx`) and the inline `OrderRow`
always lists all four funnel states (`PAID/PROCESSING/SHIPPED/DELIVERED`)
regardless of the order's current status, and the server action applied the
chosen status with only an atomic `updateMany({ where:{ id, status:current } })`
precondition — which asserts the status hasn't changed concurrently, **not** that
the requested transition is legal. BUG-022 added a terminal-exit guard
(REFUNDED/CANCELED can't be re-fulfilled), but everything else was unguarded.

So an admin (or a stale/duplicate form re-submit, or a crafted POST) could:
- Move an order **backward**: DELIVERED→PROCESSING, SHIPPED→PAID, DELIVERED→SHIPPED.
- **Fulfil an unpaid order**: PENDING_PAYMENT→PROCESSING/SHIPPED (PROCESSING wasn't
  even caught by the address guard) — shipping goods against an order that never
  cleared payment.
- Set **CANCELED/REFUNDED via the fulfilment panel**, bypassing the dedicated
  `cancelOrder`/`refundOrder` actions that own the stock **restock** → terminal
  state with no restock.

**Impact:** buyers told a delivered order is "processing" again; unpaid orders
dispatched; canceled/refunded states reached without restock. Violates S3
(monotonic status transitions) and risks F14 (a PENDING_PAYMENT→PAID via this
path would set `status=PAID` with `paidAt=null`, since fulfilment never writes
`paidAt`).

**Root cause:** no transition-legality check; the action trusted whatever status
the form/POST supplied.

**Fix (working copy):** added a forward-only monotonicity guard after the
tracking auto-bump and before the side-effecting `updateMany`. Defines the funnel
`['PAID','PROCESSING','SHIPPED','DELIVERED']` and, only when the status actually
changes:
1. rejects `CANCELED`/`REFUNDED` targets → directs operator to the Refund/Cancel
   action (preserves restock ownership);
2. rejects fulfilment of a not-yet-paid order (current status outside the funnel,
   e.g. PENDING_PAYMENT) → directs to record payment first;
3. rejects any backward move (`rank(target) < rank(current)`).
Same-status edits (attach/adjust tracking on a row) remain allowed — the existing
idempotency no-op path is untouched. Payment (→PAID) stays owned by
`markOrderPaidManually`/`verifyPayment`; cancel/refund stay owned by their actions.
Scope kept tight: no broader refactor of those other actions.

**Manual-payment posture:** unaffected — no Stripe/card/pay-now wording; bank-transfer
flow and the manual payment/verify actions are untouched.

**Verification this round (no browser):** exhaustive simulation of all 49
(current × target) state pairs against the implemented guard logic — every legal
forward funnel move ALLOWs, every backward/skip-unpaid/terminal-exit/
cancel-via-fulfilment move BLOCKs, same-status no-ops ALLOW. `tsc --noEmit` exits 0.

**Verify (browser, when a session is available):** on a DELIVERED test order try
to set PROCESSING → expect rejection, status stays DELIVERED; on a PENDING_PAYMENT
order try SHIPPED → expect "not yet paid" rejection; confirm a normal
PAID→PROCESSING→SHIPPED→DELIVERED run is unaffected and tracking edits on an
existing row still save.

### Tooling incident — Edit-tool truncation (recovered)
Applying the BUG-026 guard via the Edit tool silently truncated the tail of
`src/app/admin/actions.ts` (file dropped from a healthy state to ending mid-body
in `rejectPayment`; brace count 1231/1230). Detected immediately by the post-edit
`tsc` (TS1005 at EOF). **Recovered** by appending the lost tail of `rejectPayment`
from `git show HEAD` (the function's surviving head was byte-identical to HEAD
through the cut point, and it is the last function in the file) via the **shell**,
not the Edit tool. Post-recovery: braces 1266/1266, parens balanced, `tsc --noEmit`
exits 0. Lesson re-confirmed (3rd occurrence in this project): **for large `.ts`
files, prefer shell writes and `tsc` after every change.**

### Invariant reconciliation (code reads, this round)
- **F11** proformaNumber immutability → ✅ code: single write site
  (`sendProforma`) reuses the existing number (`sr.proformaNumber || …`); the
  generated value is also deterministic (derived from sr.id). No guard needed.
- **F15** paymentVerificationStatus machine → ✅ code-verified: buyer upload
  sets AWAITING_VERIFICATION; `verifyPayment`/`rejectPayment` precondition +
  atomic `updateMany` WHERE guards; no skip/backwards path.
- **S4** admin-cancel restock once-only → ✅ code-verified: `cancelOrder`
  status precondition + `increment` restock; `refundOrder` idempotency guard +
  `$transaction`.

## NEW — 2026-06-09 (round: mass filesystem-corruption recovery — BUILD WAS BROKEN ON ARRIVAL)

> Chrome NOT connected → no browser verification. `tsc --noEmit` exited **2** at
> the start of this run (build broken) and exits **0** at the end. This round was
> entirely an emergency build-recovery; no new feature/flow work.

### NEW BUG-027 · P0 · FIXED (code; build-green, browser-unverified) · Tooling/Integrity · Mass filesystem corruption broke the build across 35 source files
**Symptom:** on arrival `tsc --noEmit` failed across ~34 files. Two corruption modes:
- **17 files: trailing NUL-byte padding** (`0x00` appended past EOF → TS1127). Content
  intact — 16 stripped to byte-identical to HEAD; the 17th was `marketplace/[slug]`
  (BUG-024) and complete.
- **17 files: hard truncation** (content cut mid-statement → unterminated literals /
  missing close tags). 14 were exact **prefixes of HEAD** (lossless HEAD restore); 3
  fix-bearing files (`admin/actions.ts`, `quotes/actions.ts`, `api/auth/[...all]/route.ts`)
  recovered from git stash `user-local-edits-pre-server-sync` (clean blobs).

**Recovery (all non-destructive; corrupted originals saved to
`.backups/nul-corruption-2026-06-09/`):** de-padded the NUL files, restored the 14
prefix-of-HEAD files from HEAD, restored the 3 fix-bearing files + `marketplace/[slug]`
from the stash. Verified every security-fix marker survived
(BUG-009/018/022/023/024/025/026 present). See `CHANGES-2026-06-09.md`.

**Verify (when browser/build session available):** `next build` clean; smoke-test
`/admin/companies`, recovered order/quote/auth flows.

### NEW BUG-028 · P0 · FIXED (code) · State-integrity · HEAD `admin/actions.ts` shipped a non-compiling duplicated `rejectPayment` body
**Symptom:** `admin/actions.ts` (byte-identical in HEAD and the stash) contained the
`rejectPayment` body **twice** — the function closes at line 2657, then lines 2658–2704
re-paste the same body, ending in a stray `}` (TS1128). This is a botched double-append
from the 2026-06-08 BUG-026 Edit-tool truncation recovery; **HEAD never compiled**.
Prior "tsc exits 0" claims were true of the *working copy at the time*, not of what
got committed. **Fix:** removed the duplicate block (file now ends at line 2657);
`tsc` clean. No logic change to the genuine `rejectPayment`/fulfilment guards.

### NEW BUG-029 · P1 · FIXED (code; browser-unverified) · Build · `companies/page.tsx` imported a non-existent `BrowseSupplierButton`
**Symptom:** `src/app/admin/companies/page.tsx` imports + renders
`@/components/admin/BrowseSupplierButton`, but that source file never existed in git
(untracked) and was destroyed by the corruption → TS2307 module-not-found.
**Fix:** reconstructed `src/components/admin/BrowseSupplierButton.tsx` as a thin
client button that opens the existing `ShopBrowser` in a dialog — faithful to the
sibling `CreateShopButton`/`AiSuggestShopsButton` pattern. Admin-only, no new server
actions, no data writes, no Stripe/manual-payment surface. **Verify:** open
`/admin/companies` → "Browse supplier" button → enter URL → ShopBrowser iframe loads.

### BUG-006 · REGRESSION re-applied · `minPasswordLength` was back to 8 in HEAD
Ledger/invariant A12 list password min length = 12, but HEAD shipped
`minPasswordLength: 8` (lost in an earlier "Sync server-deployed changes" commit, not
by today's corruption — the pre-corruption working copy already had 8). Re-applied
`8 → 12` in `src/lib/auth.ts`. Affects only newly-set passwords; no lockout. Invariant
A12 restored at code level.

## NEW — 2026-06-10 (round: A4 invariant — admin capability enforcement sweep)

> Chrome NOT connected this run → no browser verification possible; all statuses
> below are code-level only. `npx tsc --noEmit` exits **0** at start and end of
> the round. Build was green on arrival (last round's 2026-06-09 corruption
> recovery held). No Edit-tool truncation this round — all `.ts` edits were
> line-addressed `sed` replacements with `tsc` after each batch. Highest-priority
> unblocked item was invariant **A4** (P0 security, sitting at ⏳ "verify each
> admin action"): all OPEN *bugs* are BLOCKED (013 Stripe / 005 email-verify
> rollout / 015+016 infra / 020 config), and every code-fixable P0/P1 bug was
> already FIXED-in-code, so the right work was closing the highest unverified P0
> *invariant* that needs no browser.

### NEW BUG-030 · P0 · FIXED (code; browser-unverified) · Security/Privilege-escalation · 15 admin server actions checked role only, not capability (invariant A4)
**Files:** `src/app/admin/actions.ts`, `src/lib/sell/actions.ts`,
`src/lib/assistant/actions.ts`, `src/lib/content/actions.ts`

**Symptom (found by full code sweep of every `'use server'` action):** the app
ships a granular admin capability model (`src/lib/capabilities.ts`: presets
SUPER_ADMIN/OPS/FINANCE/SUPPORT/CONTENT/CATALOG; `requireCapability` enforces a
specific cap) and the admin **nav** (`src/app/admin/layout.tsx`) correctly hides
each section behind its cap. But 15 mutating admin server actions gated only on
`requireAdmin()` / `requireSession({ roles:['ADMIN'] })` — i.e. **any** admin,
regardless of their granted caps. A scoped admin (e.g. the SUPPORT preset =
tickets-only, who cannot even *see* the Catalog/Content/Settings sections) could
still invoke these actions directly and act outside their role.

**Affected actions (now capability-gated to match the nav/section model):**
- Testimonials CRUD — `createTestimonial`/`deleteTestimonial`/`toggleTestimonial` → **`content:cms`**
- Case-studies CRUD — `createCaseStudy`/`deleteCaseStudy`/`toggleCaseStudy` → **`content:cms`**
- Lab-rental facilities CRUD — `createFacility`/`deleteFacility`/`toggleFacility` → **`content:cms`**
- Brands CRUD — `createBrand`/`updateBrand`/`deleteBrand` → **`products:edit`** (matches the Brands nav link's `can('products:edit')`)
- Settings diagnostics — `testIntegration`/`verifySetting` → **`settings:view`** (matches `listWebhooks` read gating; no mutation)
- Buyer↔seller thread reply — `replyToThread` → **`messages:reply`**
- Acquisitions/sell workflow — `replySellSubmission` → **`sell:reply`**; `proposeAcquisitionPrice`/`markAcquisitionReceived`/`completeAcquisition`/`uploadReceiptAndComplete` → **`sell:status`**
- AI-assistant admin (surfaced under `/admin/messages`) — `adminClaimConversation`/`adminReplyConversation`/`adminCloseConversation` → **`messages:reply`**
- Blog/Wiki content (new/edit page actions) — `createBlogPost`/`updateBlogPost`/`createWikiArticle`/`updateWikiArticle` via the shared `actor()` helper in `content/actions.ts` → **`content:write`** (matches the Blog/Wiki nav and the already-correct `lib/blog/actions.ts`)

**Impact:** privilege escalation between admin tiers. A content/support/finance/
catalog-scoped admin could perform actions the capability model is designed to
deny them (publish testimonials/case-studies, mutate brands, probe integration
secrets via diagnostics, post into buyer↔seller threads, drive the acquisitions
money-workflow, claim/close assistant conversations, publish blog/wiki). No
buyer-facing or anonymous exposure — requires an authenticated ADMIN — hence
privilege-tier escalation rather than full RCE/data-exfil, but it defeats the
entire scoped-admin design and the principle of least privilege.

**Root cause:** these actions predate (or were missed by) the capability rollout
that converted most of `admin/actions.ts` to `requireCap(...)`. The helper
`requireCap` also discarded its `Session` return; `replyToThread` (which needs
`session.user.id`) therefore couldn't adopt it — fixed by making `requireCap`
return the session (`return requireCapability(...)`, backward-compatible; all
prior callers ignore the value).

**Fix (working copy):** replaced the role-only gate with `requireCapability(<cap>)`
in all 15 actions, choosing each cap to match the existing nav/section gating so
"can see the section" ⇔ "can act in it". Cleaned one now-unused `requireSession`
import (`assistant/actions.ts`) and swapped `content/actions.ts`'s import.
No business-logic, data-shape, or manual-payment-posture changes — pure
authorization tightening. Bank-transfer wording untouched; no Stripe/card/pay-now
copy introduced.

**Deliberately left role-only (correct, NOT a gap):** `getMyAdminNotifications`,
`markNotificationRead`, `markAllNotificationsRead` operate only on
`userId: session.user.id` (the calling admin's own notification bell) — no
capability is appropriate for self-service on own data. (Their `where:{readAt:null}`
guard also satisfies invariant **S7**: `readAt` is write-once → only flips forward;
recorded in INVARIANTS.md.)

**Verification this round (no browser):** every `'use server'` file swept; after
the fix the only remaining ADMIN-role-only actions are the three self-service
notification functions above. All other admin actions are capability-gated (a
number are redundantly double-gated `requireSession`→`requireCap`; left as-is, no
drive-by refactor). All 7 assigned cap strings validated against
`CAPABILITIES` in `capabilities.ts`. `tsc --noEmit` exits 0.

**Verify (browser, when a scoped-admin session is available):** sign in as a
SUPPORT-preset admin (tickets-only) and attempt each fixed action via its server
endpoint → expect redirect to `/admin?forbidden=<cap>`; sign in as OPS/CONTENT/
CATALOG and confirm the matching actions still succeed. (Matches invariant B10:
"admin without cap → forbidden".)

### Backups
Corrupted-proof originals of all four edited files saved to
`.backups/a4-capgate-2026-06-10/` before editing.

## NEW — 2026-06-11 (round: F1 closure + BUG-019 buyer-facing archive closure)

> Chrome NOT connected this run (list_connected_browsers = []) → no browser
> verification possible; all statuses below are code-level only. `npx tsc
> --noEmit` exits 0 at start and end. All OPEN P0/P1 bugs remain BLOCKED
> (013 Stripe decision / 005 email-verify rollout / 015+016 infra / 020 config),
> so this round closed the last ⏳ P0 financial invariant (F1) and the highest
> non-blocked OPEN bug (BUG-019, P2).

### Invariant F1 → ✅ code-verified (was ⏳)
Swept every `totalCents` write site in `src/`:
- `orders/actions.startCheckoutWithAddress` — total = subtotal+shipping+tax;
  single item, snapshot = priceCents ×1 = subtotal. ✅
- `cart/actions.startCartCheckoutWithAddress` — subtotal = Σ price×qty over
  reserved items; items snapshot price each; total = subtotal+shipping+tax. ✅
- `quotes/actions.sendProforma` (materialize + BUG-023 re-issue) — subtotal =
  proforma price; single line snapshot = subtotal; re-issue updates totals
  atomically (PENDING_PAYMENT precondition) and syncs the item snapshot. ✅
No other code writes totalCents. F1 holds at code level on all paths.

### NEW BUG-031 · P3 · FIXED (code; browser-unverified) · Config-dependent display mismatch · Proforma "Amount" omits default shipping/tax applied to the materialized order
**File:** `src/lib/quotes/actions.ts` — `sendProforma`
**Symptom (code read):** the proforma email/`paymentInstructionsSnapshot` state
`Amount: <priceCents>` only, while the materialized order's `totalCents` adds
`DEFAULT_SHIPPING_CENTS` + `DEFAULT_TAX_PERCENT`. With both env defaults at 0
(current posture) the amounts match and there is NO user impact. If the owner
ever sets nonzero defaults, the buyer would be instructed to transfer less than
the order total. Not fixed this round (zero impact today; correct fix is a
product decision: either include shipping/tax lines on the proforma or exclude
env defaults from quote-path orders).

### BUG-019 · P2 · FIXED (code; browser-unverified) · Buyer-facing closure for archived-but-unresolved tickets/quotes
**Files:** `src/lib/quotes/deal-state.ts`, `src/app/app/quotes/page.tsx`,
`src/app/app/quotes/[id]/page.tsx`, `src/app/app/support/page.tsx`
**Fix (working copy):** chose the ledger's "surface a buyer-facing closed
state" remedy (lighter than forcing a terminal status at archive time, and
composes with BUG-018's reply-auto-unarchives):
- `computeDealState` gains an optional `archivedAt` input. When the deal would
  land in a *waiting* state (awaiting_supplier / awaiting_buyer) but the SR is
  archived → returns `lost_closed` with label "Closed by our team". The
  proforma/order stages are deliberately NOT overridden (those still carry a
  real buyer action: decide / pay). Admin surfaces don't pass `archivedAt`, so
  ops keep seeing the true operational state + their own ARCHIVED badge.
- Buyer "My quotes" list passes `archivedAt`; archived waiting quotes now land
  in the Lost tab with status line "Closed by our team · reply in the thread
  to reopen" instead of an eternal "Waiting for supplier".
- Buyer quote thread passes `archivedAt` for a consistent header badge.
- Buyer `/app/support`: a ticket archived in a non-terminal status now shows
  badge "Closed by support" (instead of "Awaiting your reply"/"Support is
  replying") plus an inline note: "Our support team closed this conversation.
  Replying below will reopen it." Reply form stays — replying auto-unarchives
  (BUG-018) and the live state returns.
**Verify (browser, when session available):** archive a TEST ticket in
WAITING_ON_CUSTOMER → buyer sees "Closed by support" + note; buyer replies →
ticket returns to admin Open queue AND buyer badge returns to live state.
Repeat for an RFQ with no proforma → "Closed by our team" in Lost tab.

### Tooling incidents this round (all recovered; build green)
1. **Edit-tool truncation, 4th occurrence** — all four BUG-019 files were
   tail-truncated by the Edit tool. Detected by post-edit `tsc` (exit 2).
   Recovered: corrupted copies saved to `.backups/bug019-truncation-2026-06-11/`,
   files restored from `git show HEAD:` (pre-edit working copies were
   byte-identical to HEAD), edits re-applied via a shell-side Python patcher
   (exact-match, count-asserted, CRLF-preserving). `tsc --noEmit` exits 0.
   Rule hardened: do NOT use the Edit tool on this project's source files at
   all — shell-side patching only.
2. **BUGS.md itself was truncated by the filesystem** mid-round (974 → ~911
   lines, cutting BUG-030's body mid-word and swallowing this round's first
   appended report). Same corruption class as BUG-027. Reconstructed from the
   in-session ledger read and re-written; a safety copy now lives at
   `.backups/ledger-2026-06-11/BUGS.md`.
3. **Stale `.git/index.lock`** (0 bytes, dated 2026-06-07) blocks every
   index-mutating git command (`checkout --`, `add`, `commit`). No git process
   is running; the sandbox cannot delete it (`Operation not permitted` through
   the mount). Worked around with `git show` (read-only). **Needs from user:**
   delete `.git/index.lock` manually (file explorer or `del .git\index.lock`)
   so git works normally again.

## NEW — 2026-06-12 (round: invariant S1 read-staleness closure)

> Chrome NOT connected this run (list_connected_browsers = []) → no browser
> verification possible; all statuses below are code-level only. `npx tsc
> --noEmit` exits 0 at start and end. **`.git/index.lock` is GONE** (user
> removed it) — git is fully operational again. Ledgers + working tree arrived
> intact: no filesystem corruption detected this round, and no Edit-tool use on
> sources (shell-side count-asserted patching only; zero truncation incidents).
> All OPEN P0/P1 bugs remain BLOCKED (013 Stripe decision / 005 email-verify
> rollout / 015+016 infra / 020 config / 031 product decision), so this round
> closed the last 🟡 state-consistency invariant needing no browser: **S1**.

### NEW BUG-032 · P1 · FIXED (code; browser-unverified) · Financial-trust/UX · Cart checkout silently dropped sold-out items from the created order (invariant S1)
**Files:** `src/lib/cart/actions.ts` (`startCartCheckoutWithAddress`),
`src/app/app/cart/page.tsx`, `src/app/checkout/cart/page.tsx`

**Symptom (found by code read):** three compounding read-staleness gaps:
1. **Silent item drop (the real bug):** `startCartCheckoutWithAddress` filtered
   `i.product.quantity > 0` out of `valid` — but BOTH display surfaces (cart
   page and `/checkout/cart` order summary) filter only on
   PUBLISHED/priced/!QUOTE_ONLY, i.e. they SHOW sold-out items as buyable. A
   buyer whose item sold out after adding it saw an order summary including
   that item, submitted, and the order was created WITHOUT it at a recomputed
   lower total — no message, no consent. Honest totals, dishonest contents.
2. **Unexplained bounces:** checkout failure redirects carry
   `?unavailable=1` / `?mixedcurrency=1` / `?empty=1` (and Stripe-path
   `?canceled=1` / `?payment=error`), but `/app/cart` rendered none of them —
   only `?added`. Buyer was bounced back to the cart with zero explanation.
3. **No read-time stock signal:** the cart page didn't even select
   `product.quantity`, so a stale line (sold out, or qty > remaining stock)
   looked perfectly orderable until checkout failed.

**Fix (working copy, scope-tight):**
- `cart/actions.ts`: removed the `quantity > 0` filter — sold-out items now
  flow into the existing atomic reservation loop, fail it
  (`updateMany where quantity >= wanted` → count 0), trigger full rollback of
  the other reservations and redirect to `/app/cart?unavailable=1`. An order
  can no longer be created with fewer items than the buyer was shown.
- `/app/cart`: selects `quantity`; renders banners for
  unavailable/mixedcurrency/empty/canceled/payment flags; per-line badges
  ("Sold out — remove this item to continue" / "Only N left — lower the
  quantity"); sold-out lines show "—" total, are excluded from the subtotal and
  lose the qty form; checkout CTA is disabled with an explanation while any
  line is stock-blocked. Qty input max/default now clamp to remaining stock.
- `/checkout/cart`: selects `quantity`; server-side guard redirects any
  stale-stock cart back to `/app/cart?unavailable=1` BEFORE rendering an order
  summary that could not be fulfilled.

**Manual-payment posture:** untouched — bank-transfer wording only; no
Stripe/card/pay-now copy. Reservation/rollback logic unchanged (S2/F5/F6).

**Verify (browser, when session + test product available):** add 2 units of a
1-unit product → cart shows "Only 1 left", CTA disabled; set product qty to 0
as admin → cart shows "Sold out", subtotal excludes line, CTA disabled;
/checkout/cart with a stale cart → bounced to cart with the red banner; a
normal in-stock cart checks out unchanged.

**Invariant impact:** S1 → ✅ code (write-time clamp + read-time surfacing +
no-silent-drop checkout). Backups of pre-patch files:
`.backups/bug032-2026-06-12/`.


---

## NEW — 2026-06-13 (round: BUG-015 + BUG-016 moved from "infra-owner/blocked" to in-repo config fixes)

> Chrome NOT connected this run (list_connected_browsers = []) → no browser
> verification possible; statuses below are code/config level only. `npx tsc
> --noEmit` exits 0 at start and end. `.git/index.lock` absent, git operational.
> No filesystem corruption this round; no Edit-tool use on sources (shell-side
> count-asserted patching only). Backups: `.backups/bug015-016-2026-06-13/`.
>
> **Re-classification correction:** prior rounds parked BUG-015 and BUG-016 as
> "infra owner, app code unchanged / BLOCKED." That was wrong — the relevant
> infra is REPO-TRACKED config the user deploys (`nginx/lab2date.conf`,
> `docker-compose.yml` `minio-init`, and the app-level bucket policy in
> `src/lib/storage/s3.ts`). Neither needs credentials, a live session,
> destructive SQL, or a business decision, so neither is actually blocked.
> Both fixed in-repo this round.

### BUG-015 — fix applied (`nginx/lab2date.conf`)
Root cause (per the confirmed diagnosis): the single Next.js standalone process
saturated under concurrent `_rsc` prefetch bursts and nginx returned 503 for the
connections it couldn't proxy. The vhost made this worse by (a) having **no
upstream keepalive** (`proxy_pass http://127.0.0.1:3100;` opens a fresh upstream
TCP connection per request) and (b) hardcoding `proxy_set_header Connection
"upgrade";` on **every** request, which defeats HTTP/1.1 keepalive reuse.
**Fix:**
- Added http-context `upstream lab2date_web { server 127.0.0.1:3100; keepalive 64; }`.
- Added `map $http_upgrade $connection_upgrade { default upgrade; '' ""; }` so
  websocket upgrades still work while normal HTTP requests reuse keepalive.
- Both server blocks' `location /` now `proxy_pass http://lab2date_web;` and
  `proxy_set_header Connection $connection_upgrade;` (kept `proxy_http_version 1.1`).
Connection churn under burst is eliminated; concurrent SSR renders reuse a pool
of up to 64 kept-alive upstream connections instead of exhausting the upstream.
Brace-balanced; nginx binary unavailable in sandbox so `nginx -t` not run —
**user should run `nginx -t` before reload.** Optionally still scale to 2–4 web
replicas for headroom (separate, non-blocking).

### BUG-016 — fix applied (`docker-compose.yml` + `src/lib/storage/s3.ts`)
Root cause: only the `products/*` prefix is granted anonymous read. Runtime
uploads all land under `products/` (`safeKey()` → `products/<id>.<ext>`), so they
load fine — but blog cover images are **seeded** under a separate `blog-cover/*`
prefix that no policy covers, so MinIO returns 403 (`AccessDenied`). The bucket
also holds PRIVATE objects (`support-att/*`, payment `proof` keys) served only via
auth-gated proxies, so a bucket-wide public policy is NOT acceptable.
**Fix (per-prefix, scope-tight — private prefixes untouched):**
- `docker-compose.yml` `minio-init`: added
  `mc anonymous set download "local/$S3_BUCKET/blog-cover";` next to the existing
  `products` grant (self-host/dev path).
- `src/lib/storage/s3.ts` `ensureBucket()` policy: added
  `arn:aws:s3:::${BUCKET}/blog-cover/*` to the public-read `Resource` array
  (authoritative path — re-applied on every boot for R2/AWS/MinIO alike).
Only `blog-cover` was confirmed 403; if other seeded public prefixes surface the
same way, the same one-line per-prefix grant applies. tsc still exits 0.

### Still genuinely BLOCKED (unchanged)
- **BUG-013** (Stripe) — manual-payment is the official posture; not a launch
  blocker. Needs a business decision + credentials. BLOCKED.
- **BUG-005** (email verification on sign-up) — rollout/UX decision + email
  deliverability. BLOCKED.
- **BUG-020** (notification inbox config) — owner edits in `/admin/settings`
  (`.local` sell inbox, empty quote-intake inbox, Resend domain). Config, not
  code. BLOCKED on owner.
- **BUG-031 / BUG-021** — product decisions (shipping/tax on proforma; whether
  self-serve buyer payment is required). BLOCKED on owner.
- **All "FIXED (code; browser-unverified)" items** — still need a real browser
  session on the deployed build to reach VERIFIED. Chrome not connected.

---

## NEW — 2026-06-14 (round: first Chrome connection — but deployed site unreachable)

> **Headline:** For the FIRST time in this recovery loop, a Chrome browser was
> connected (`list_connected_browsers` → 1 local Windows browser), so the
> long-blocked REAL-BROWSER AUDITOR pass became theoretically possible. However,
> **`https://labtodate.com` would not load in the browser** — every navigation
> to the production domain returns Chrome's error page ("Frame is showing error
> page"), no document request reaches the origin, and `get_page_text`/screenshot
> both fail with "Cannot access … / showing error page". A control navigation to
> `https://example.com` loaded normally and returned real text in the SAME
> browser/session, so this is **specific to labtodate.com, not a browser or
> extension-permission problem.** Net: browser verification is still BLOCKED this
> round — now on site reachability rather than on Chrome being absent.
>
> `npx tsc --noEmit` exits 0 (build green). No source files were changed this
> round (every OPEN bug is BLOCKED on a user/business decision; cosmetic-only
> rule precludes drive-by work). Ledger-only updates. Backups in
> `.backups/round-2026-06-14/`.

### NEW BUG-033 · P0 · OPEN · Reliability/Availability · Deployed site `https://labtodate.com` unreachable from audit browser
**Symptom:** All navigations to `https://labtodate.com/` and `…/admin` and
`…/marketplace/<slug>` render Chrome's error page; no successful document network
request is recorded (only data: URI placeholders). `https://example.com` loads
fine in the same session → browser connectivity and extension permissions are
intact; the failure is origin-specific to labtodate.com.
**Could not determine the exact cause from the available tooling** (the chrome://
error page's text/code — DNS NXDOMAIN vs connection-refused vs TLS vs 5xx — is not
readable via the MCP page tools; the sandbox has no general DNS so a name-lookup
control was inconclusive). **Not asserting a definitive production outage** — only
that the deployed URL did not load from the audit browser this run.
**Needs from user (any one, to unblock the whole browser-audit backlog):**
- Confirm the site is actually up at `https://labtodate.com` from a normal browser
  (and that DNS resolves / TLS cert is valid / the app process + nginx are running).
- If the deployment lives at a different host/URL (staging, IP, alt domain), tell
  the orchestrator which URL to audit.
- If the site IS up for you, the audit browser may sit behind a network that can't
  reach the origin — confirm the Chrome instance running the extension can open
  `https://labtodate.com` manually.
**Until this clears, every "FIXED (code; browser-unverified)" item stays
browser-unverified** (BUG-001, 002, 004, 009-012, 014, 019, 024, 026, 030, 032;
invariants F3, F12, F13, A3, A4, A14, A15, S1, S3, S7, S10; flows B1–B17), and no
PASS/VERIFIED can be issued per the hard rule.

### Recurring infra regression noticed this round
- **`.git/index.lock` is PRESENT again** (0 bytes, dated 2026-06-13) after the
  user cleared it on 2026-06-12. It re-blocks index-mutating git ops, and the
  sandbox cannot delete it ("Operation not permitted" through the mount). Same
  class as the 2026-06-11 incident. **Needs from user:** delete
  `.git\index.lock` again, and ideally find what keeps recreating it (a crashed
  git GUI / editor git integration holding a stale lock is the usual culprit).
  Non-blocking for this orchestrator (it writes manifests for manual apply), but
  it will keep biting any direct git use.

### Status of OPEN bugs (unchanged — all still BLOCKED on user/business input)
- BUG-013 (Stripe) — business decision; manual-payment is official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — needs deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config) — owner edits in /admin/settings. BLOCKED.
- BUG-031 (proforma shipping/tax) / BUG-021 (self-serve payment) — product decisions. BLOCKED.

## NEW — 2026-06-15 (round: BUG-033 reachability re-probe — still unreachable)

> **Chrome connected** this run (`list_connected_browsers` → 1 local Windows
> browser, deviceId adf81967…). Re-ran the keystone BUG-033 reachability probe.
> **`https://labtodate.com` is STILL unreachable from the audit browser** —
> navigation lands on Chrome's error page (`get_page_text` → "Frame with ID 0 is
> showing error page"); the only network requests recorded are `data:` URI
> placeholders (the error-page illustration), i.e. **no document request to the
> origin reached the network**. Control navigation to `https://example.com`
> loaded normally and returned real text in the SAME tab/session → browser +
> extension are healthy; the failure remains origin-specific to labtodate.com.
> Symptom identical to 2026-06-14. **No PASS/VERIFIED can be issued** (hard rule).
>
> `npx tsc --noEmit` exits 0 (build green; no HEAD regression, no filesystem
> truncation this round). **No source files changed** — every OPEN bug is BLOCKED
> on a user/business decision and the cosmetic-only rule precludes drive-by work.
> Ledger-only updates. Safety copies in `.backups/round-2026-06-15/`.

### BUG-033 · P0 · OPEN (unchanged) · Deployed site unreachable from audit browser
Re-probe result 2026-06-15: unchanged from 2026-06-14. Evidence captured this run:
- `navigate https://labtodate.com/` → tab title resolves to "labtodate.com" but
  frame is an error page; `get_page_text` errors "Frame with ID 0 is showing
  error page".
- `read_network_requests` (tracking active) → 3 requests, all `data:image/png`
  placeholders (statusCode 200, the chrome error-page artwork). Zero requests to
  the labtodate.com origin. No console errors captured (page never executed).
- Control `https://example.com/` → loads, title "Example Domain". Browser/ext OK.
The chrome:// error page's exact code (DNS NXDOMAIN vs conn-refused vs TLS vs 5xx)
is still not readable via the MCP page tools, so the root cause is not asserted —
only that the deployed URL does not load from the audit browser.
**Needs from user (any one, to unblock the entire browser-audit backlog):**
- Confirm `https://labtodate.com` is actually up from a normal browser (DNS
  resolves / TLS cert valid / app process + nginx running).
- If the deployment lives at a different host/URL (staging, IP, alt domain),
  tell the orchestrator which URL to audit.
- If the site is up for you but not for the audit browser, confirm the Chrome
  instance running the extension can open `https://labtodate.com` manually
  (it may sit behind a network that can't reach the origin).

### Recurring infra regression (unchanged)
- **`.git/index.lock` is PRESENT** (0 bytes, dated 2026-06-13) — same stale lock
  flagged on 2026-06-14; the sandbox still cannot delete it ("Operation not
  permitted" through the mount). Non-blocking for this orchestrator (it writes
  manifests for manual apply) but it will keep blocking direct index-mutating
  git ops. **Needs from user:** delete `.git\index.lock` and find what keeps
  recreating it (a crashed git GUI / editor git-integration holding a stale lock).

### Status of OPEN bugs (unchanged — all still BLOCKED on user/business input)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — needs deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config) — owner edits in /admin/settings (`.local` sell inbox, empty quote-intake inbox, Resend domain). Config, not code. BLOCKED.
- BUG-031 (proforma shipping/tax) / BUG-021 (self-serve payment) — product decisions. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all "FIXED (code; browser-unverified)" promotions. BLOCKED on user.

## NEW — 2026-06-16 (round: BUG-031 proforma/order amount divergence closed)

> Chrome NOT connected this run (`list_connected_browsers` = []) → no browser
> verification possible; all statuses below are code-level only. `npx tsc
> --noEmit` exits 0 at start and end. BUG-033 (site reachability) re-probed via
> Chrome connectivity check — still no browser available, so B1–B17 and every
> "FIXED (code; browser-unverified)" promotion remain ⏳ UNVERIFIED (unchanged).
> All previously-OPEN P0/P1 items remain BLOCKED (013 Stripe decision / 005
> email-verify rollout / 015+016 infra deploy / 020 config / 033 reachability).
> The one remaining non-blocked OPEN item — BUG-031 (P3) — was previously parked
> as "product decision," but on re-read it contained a strictly-correct,
> decision-neutral code fix, applied this round.

### BUG-031 · P3 · FIXED (code; browser-unverified)
**File:** `src/lib/quotes/actions.ts` — `sendProforma`
**Root cause:** the proforma `paymentInstructionsSnapshot` printed
`Amount: <parsed.priceCents>` (the bare subtotal), while the materialized order
records `totalCents = subtotalCents + shippingCents + taxCents`. With the env
defaults `DEFAULT_SHIPPING_CENTS` / `DEFAULT_TAX_PERCENT` both 0 (current
posture) the two agree and there is no user impact; if the owner ever sets
nonzero defaults, the buyer would be instructed to bank-transfer LESS than the
order total — an under-payment / manual-reconciliation hazard.

**Why this is NOT the blocked "product decision":** whether quote-path orders
*should* carry shipping/tax remains the owner's call and is untouched. This fix
only guarantees the buyer is always told to transfer **exactly the order total
the system records**, whatever that total is. It is strictly safer (can never
instruct an under-payment) and behavior-identical at today's 0/0 posture.

**Fix (working copy, scope-tight, shell-side patch — no Edit tool):**
- Compute `proformaTotalCents = subtotal + shipping + tax` using the *identical*
  formula the order-materialization block below already uses, immediately before
  building `paymentInstructionsSnapshot`.
- The snapshot now shows a single `Amount: <total>` line when total == subtotal
  (0/0 posture — byte-identical to before for current prod), and an itemized
  `Subtotal / Shipping / Tax / Amount due` breakdown when shipping or tax are
  nonzero (prevents buyer confusion about the larger figure).
- Order-creation math (the F1-verified block) left untouched — it was already
  correct; only the *display* was lying.

**Manual-payment posture:** preserved — bank-transfer wording only; no Stripe /
card / "pay now" copy introduced.

**Logic check (offline):** simulated both formulas across {0/0, ship>0,
tax>0, mixed odd-cents}; proforma Amount == order.totalCents in every case.

**Residual nuance (not fixed; noted):** the buyer *email body* and the
`renderInvoiceHtml` line item still describe the quoted unit price (the
subtotal), which is legitimate for a price/line-item display — the authoritative
"what to transfer" figure is the payment-instructions snapshot, now corrected.
If the owner enables nonzero defaults and wants the email headline to also show
the grand total, that's a one-line follow-up (tracked here, P3).

**Verify (browser, when a session + reachable site exist):** issue a proforma
with `DEFAULT_SHIPPING_CENTS`/`DEFAULT_TAX_PERCENT` set nonzero → confirm the
emailed/stored instructions show the itemized breakdown and the `Amount due`
equals `/app/orders/<num>` order total. BLOCKED on BUG-033.

### Build + tooling this round
- `npx tsc --noEmit` exits 0 (green) before and after the change.
- Single shell-side exact-match replacement (count-asserted = 1), LF preserved;
  no Edit-tool use on source (per the hardened 2026-06-11 rule). Backups in
  `.backups/bug031-2026-06-16/`.
- No filesystem-truncation incident observed this round.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config) — owner edits in /admin/settings. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable from a connected audit browser. BLOCKED on user.

---

### BUG-033 · P0 · OPEN (unchanged) · re-probe 2026-06-17 — strongest control evidence yet
**Re-probed with a connected, working browser.** This round a real Chrome
instance was connected (`list_connected_browsers` → 1 local Windows browser,
"Browser 1"), so the failure is NOT "no browser" (as on 2026-06-16) — it is the
site itself.

**What was exercised:**
- Control: navigated the audit tab to `https://example.com/` → loaded a real
  page (tab title "Example Domain", real DOM). Browser + extension + network
  path are healthy.
- Target: navigated the SAME tab to `https://labtodate.com/` (three attempts,
  incl. from an already-loaded real page to rule out the chrome://newtab quirk).
  The tab URL/title resolves to `labtodate.com`, but the frame is a Chrome
  **error page**: `get_page_text`, `read_page`, and `computer:screenshot` all
  fail with "Frame with ID 0 is showing error page". No document/network request
  to the origin was recorded for the tab.

**Conclusion:** symptom unchanged from 2026-06-14/06-15 — the deployed site is
unreachable from the audit browser while a control origin loads fine in the same
session. This is now the strongest disambiguation to date: the browser works,
labtodate.com specifically does not resolve to a served document. Most likely
DNS/origin/deployment-availability (NXDOMAIN, connection refused, or the app not
served), NOT a browser-side problem.

**Consequence (hard rule):** B1–B17 and every "FIXED (code; browser-unverified)"
item remain ⏳ UNVERIFIED. No promotion to ✅ browser-VERIFIED is permitted.
The 2026-05-29 browser-VERIFIED items (S6, N3) stand and are unaffected.

**Need from user to unblock:** confirm `https://labtodate.com` is actually
deployed and serving (check DNS A/AAAA record resolves, origin/container is up,
TLS cert valid, nginx upstream healthy). Once a curl/browser from any network
returns the app HTML, this re-probe can promote the browser-unverified backlog.

### Build + tooling this round (2026-06-17)
- `npx tsc --noEmit` exits 0 (green). No source files changed this round — the
  only genuinely OPEN items are all BLOCKED (BUG-013 business, BUG-005 + BUG-020
  user-config, BUG-033 infra), so CODE AGENT MODE had no non-blocked target.
- No filesystem-truncation incident observed this round.
- Ledger backups: `.backups/ledger-2026-06-17/`.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config) — owner edits in /admin/settings + Resend domain verify. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable. BLOCKED on user/infra.

---

### BUG-034 · P1 · FIXED (code; browser-unverified — found+fixed 2026-06-18) · Data-integrity/Trust · Proforma-expiry cron cancels orders that have an unverified receipt in flight

**File:** `src/app/api/cron/sla-sweep/route.ts` (proforma-expiry sweep)

**Symptom:** A buyer uploads a payment receipt for a quote/proforma order (order
moves to `paymentVerificationStatus = AWAITING_VERIFICATION`, but `status`
deliberately STAYS `PENDING_PAYMENT` — only an admin verify flips it to PAID).
If the proforma's `validUntilAt` lapses in the window before the admin verifies,
the proforma-expiry sweep closes the `SourcingRequest` (→ CLOSED/"Lost") and
its linked-order `updateMany` cancels the order purely on
`status: 'PENDING_PAYMENT'`. The buyer's paid-in-real-life order is auto-canceled
and the deal is wrongly marked Lost while a valid receipt sits in the admin
verify queue.

**Root cause:** The proforma sweep's cancel was unguarded:
```
where: { sourcingRequestId: q.id, status: 'PENDING_PAYMENT' }
```
It did NOT check `paymentSubmittedAt`. This is inconsistent with the orphan-order
sweep immediately below it, which already guards on `paymentSubmittedAt: null`
(both in its candidate query and its atomic update) precisely so a buyer who
submitted proof is never cancelled. The buyer-submit action also re-checks the
proforma TTL and refuses NEW submissions after expiry — but it cannot protect a
receipt that was submitted just BEFORE expiry and not yet verified.

**Impact:** Manual-payment posture violation. A buyer who paid loses their order;
admin loses the verify-queue item; deal silently moves to Lost. Low frequency
(needs expiry within the verify window) but high trust/data-integrity cost, and
it directly contradicts the "admin verify is the ONLY path that changes payment
state" invariant by letting a cron destroy a paid order.

**Fix (this round):**
1. Before acting on an expired proforma, `findFirst` any linked order with
   `status: 'PENDING_PAYMENT'` AND `paymentSubmittedAt != null`; if one exists,
   `continue` — skip the whole expiry action (no close, no cancel). The buyer
   acted before expiry; leave it for the admin's verify/reject queue.
2. Defense-in-depth: add `paymentSubmittedAt: null` to the linked-order cancel
   `updateMany` WHERE, closing the race between the pre-check and the
   transaction (same posture as the orphan sweep).

No schema change. No Stripe coupling. Strengthens manual-payment integrity.
`npx tsc --noEmit` green after the change.

**Verification status:** ⏳ browser-UNVERIFIED — this is a cron-only server path
(`POST /api/cron/sla-sweep`, secret-gated) with no UI surface, so it is not
browser-testable even once BUG-033 clears. Proper verification = a seeded
integration run: create a RESPONDED proforma with `validUntilAt` in the past +
a linked PENDING_PAYMENT order with `paymentSubmittedAt` set, fire the sweep,
assert the order stays PENDING_PAYMENT/AWAITING_VERIFICATION and the proforma
stays RESPONDED. Logged as a follow-up task.

---

## 2026-06-18 — round log

**BUG-033 re-probe (REAL-BROWSER AUDITOR, control-vs-target).** A browser was
connected ("Browser 1", Windows, local). Control: navigated tab to
`https://example.com/` → real page, `get_page_text` returned real content.
Target: navigated the same tab to `https://labtodate.com/` → tab URL/title
resolve to `labtodate.com` but `get_page_text` fails with "Frame with ID 0 is
showing error page"; `read_network_requests` shows only the Chrome error page's
own inline `data:image/png` assets — zero requests to the labtodate.com origin.
Independent `web_fetch https://labtodate.com/` returned an empty body. Verdict
UNCHANGED from 06-14/06-15/06-17: the deployed site is unreachable while a
control origin loads fine in the same session → site/deployment fault, not the
browser. B1–B17 and the browser-unverified backlog remain ⏳ UNVERIFIED. BLOCKED
on user/infra (DNS/origin/TLS/nginx).

**New bug found + fixed:** BUG-034 (above) — proforma-expiry sweep could cancel
an order with an unverified receipt in flight. Fixed in code (P1).

**Build:** `npx tsc --noEmit` exits 0 before and after the change.

**Filesystem note:** the first Edit to `route.ts` truncated the file tail
(orphan-sweep notify block + the JSON summary `return` + the `GET` handler were
lost; backtick count went 72→61, tsc failed with "Unterminated template
literal"). Detected immediately by the post-edit tsc gate + a diff against the
fresh backup, and corrected by rebuilding the file from
`.backups/ledger-2026-06-18/route.ts.bak` with only the two intended changes
re-applied (verified: diff shows ONLY the BUG-034 additions; tsc green;
backticks back to 72). This is the recurring local-FS truncation hazard noted in
earlier rounds — the backup-first + tsc-gate + diff workflow caught it cleanly.

**Backups:** `.backups/ledger-2026-06-18/` (BUGS.md, INVARIANTS.md, route.ts.bak).

**Still BLOCKED (needs user):** BUG-013 (Stripe — business; manual-payment is
official, not a launch blocker), BUG-005 (email-verification rollout), BUG-020
(notification inbox config), BUG-033 (site reachability — keystone).

---

## NEW — 2026-06-19 (round: receipt-in-flight protection generalized to admin cancel paths)

> Browser connected ("Browser 1", local Windows). BUG-033 re-probed: control
> `https://example.com/` loads (real DOM); target `https://labtodate.com/` →
> Chrome error page ("Frame with ID 0 is showing error page"). Site still
> unreachable → BLOCKED, evidence refreshed. All B1–B17 + browser-unverified
> promotions remain ⏳ UNVERIFIED. The genuinely-OPEN cataloged items are all
> BLOCKED on user/infra (013 Stripe-business, 005 email-verify rollout, 020
> notification config, 033 reachability), so CODE AGENT MODE ran a fresh
> invariant sweep adjacent to last round's BUG-034 and found a sibling bug.

### NEW BUG-035 · P1 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Financial/State-integrity/Trust · Admin cancel paths could cancel a receipt-in-flight order
**File:** `src/app/admin/actions.ts` — `cancelOrder` (single) and `bulkCancelOrders`.

**Symptom / root cause:** Last round BUG-034 fixed the *cron* proforma-expiry
sweep so it never cancels an order whose buyer has uploaded a receipt
(`status=PENDING_PAYMENT` but `paymentSubmittedAt != null`,
`paymentVerificationStatus=AWAITING_VERIFICATION`). The two **admin** cancel
paths had the identical gap:
- `bulkCancelOrders` selected candidates purely on `status:'PENDING_PAYMENT'`
  and `updateMany`'d them to `CANCELED`. Because an awaiting-verification order
  KEEPS `status=PENDING_PAYMENT` until an admin verifies, a routine "cancel all
  stale pending" bulk action silently swallowed orders where the buyer had
  paid and was waiting — and the buyer notification literally says *"no charge
  was made"* (false).
- single `cancelOrder` had no `paymentSubmittedAt` guard either (only a
  PAID/PROCESSING/SHIPPED → "use Refund" guard), so it too could cancel an
  awaiting-verification order and send the same false notice.

This directly violates the manual-payment invariant that **admin verify/reject
is the ONLY path that changes payment state** — a cancel must not be able to
yank a paid-but-unverified order out of the verify queue. The proper way to
decline a submitted receipt is `rejectPayment` (which clears
`paymentSubmittedAt` and sets REJECTED), after which the order is freely
cancelable.

**Fix (this round, shell-side exact-match patch, count-asserted = 1 each):**
1. `bulkCancelOrders`: added `paymentSubmittedAt: null` to the candidate
   `findMany` WHERE **and** to the `updateMany` WHERE (defense-in-depth race
   guard, same posture as the orphan sweep). Added a cheap `count` of
   selected-but-in-flight orders so the operator gets honest feedback
   ("Canceled N. Skipped M with a receipt awaiting verification.") instead of a
   silently smaller count. When ALL selected are in-flight, returns an
   instructive `ok:false` message pointing to Verify/Reject.
2. single `cancelOrder`: added `paymentSubmittedAt` to the select and a guard
   after the PAID-state check — if a receipt is in flight, throw
   *"This order has a payment receipt awaiting verification — use Verify or
   Reject, not Cancel."* (mirrors the existing "use Refund instead" guard style).

**Manual-payment posture:** preserved — no Stripe/card/"pay now" copy; bank
-transfer/verify-queue language only. No schema change. No Stripe coupling.

**Build:** `npx tsc --noEmit` exits 0 before and after. Diff vs
`.backups/bug035-2026-06-19/actions.ts.bak` shows ONLY the BUG-035 additions;
file 2657 → 2688 lines, backticks 188 → 190 (the two new template literals).
No filesystem-truncation incident this round.

**Verification:** Cron + bulk + single cancel are all server-only / no
browser-testable confirmation surface (and BUG-033 keeps the site unreachable
anyway), so this is ⏳ browser-UNVERIFIED. Instead codified an offline
regression matrix — `scripts/verify-receipt-in-flight-guards.ts` — that
re-implements all four cancel paths' WHERE predicates and asserts a
receipt-in-flight order is excluded by every one while clean-pending controls
stay cancelable. Runs green (`node --experimental-strip-types …` → exit 0;
`npx tsx` unavailable in this Linux sandbox because node_modules carries the
Windows esbuild binary). The matrix is meaningful: reverting either guard flips
`A_receipt_in_flight` to `cancels=true` → the script exits 1.

**Invariant:** generalized as **S11** in INVARIANTS.md (receipt-in-flight
protection across ALL four cancel paths), and S4 annotated.

### Build + tooling this round (2026-06-19)
- `npx tsc --noEmit` exits 0 (green).
- Single source file changed (`src/app/admin/actions.ts`) + one new script
  (`scripts/verify-receipt-in-flight-guards.ts`). Backups:
  `.backups/bug035-2026-06-19/` (actions.ts, BUGS.md, INVARIANTS.md).
- Edit-tool NOT used on source (documented local-FS truncation hazard); patched
  via count-asserted shell-side replacement + tsc gate + diff-vs-backup.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in /admin/settings. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable from any network. BLOCKED on user/infra.
- BUG-034 — proper verification still wants a seeded integration run (DB-backed); the offline matrix above covers the guard logic in the meantime.

## NEW — 2026-06-20 (round: restock-once atomicity sweep — sibling of S4 cancel/refund)

> BUG-033 re-probed (browser "Browser 1", local Windows, connected). Control nav
> to `https://example.com/` loaded real DOM (`get_page_text` returned the real
> "Example Domain" body). Target nav to `https://labtodate.com/` left the frame on
> a Chrome error page — `get_page_text` still returned the prior example.com page
> and `read_network_requests(urlPattern:"labtodate")` recorded ZERO requests to
> the origin. Verdict unchanged from 06-14/15/17/18/19: deployed site unreachable
> while a control origin loads in the same session → site/deploy fault, not the
> browser. Needs owner to confirm DNS/origin/TLS/nginx. B1–B17 + the
> browser-unverified backlog remain ⏳ UNVERIFIED.
>
> The cataloged genuinely-OPEN items are all still BLOCKED on user/infra (013
> Stripe-business, 005 email-verify rollout, 020 notification config, 033
> reachability), so CODE AGENT MODE ran a fresh invariant sweep adjacent to the
> S4 cancel/refund work of the last two rounds (BUG-034/035) and found a real
> concurrency defect in the same family.

### NEW BUG-036 · P1 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Financial/State-integrity · Admin `cancelOrder` / `refundOrder` restock is not atomic — concurrent double-click double-restocks (and double-notifies)
**File:** `src/app/admin/actions.ts` — `refundOrder` and single `cancelOrder`.

**Symptom / root cause:** both actions did a snapshot read (`findUnique`) to
validate state, then performed the status transition with an **unconditional**
`prisma.order.update({ where: { id } })` followed by a restock loop
(`product.update … quantity:{increment}`) plus buyer notification, refund email,
audit and `notifyAdmins`. The status precondition lived only in the in-memory
`if` checks on the stale snapshot — it was **not** encoded in the write's WHERE.
So two interleaved admin requests (double-click, two operators, or a retry on a
slow response) both pass the snapshot guard, both writes succeed (update-by-id
always matches an existing row), and **both run the restock loop** →
`Product.quantity` is incremented twice for the same order, and the buyer
receives two "order canceled" / "refund issued" notices (the latter literally
re-sends the refund email). This violates invariant **S4** ("cancelling/refunding
an order returns stock once and only once"). The bug bites hardest on the
manual-payment path: with no Stripe PaymentIntent to natively dedupe, nothing
upstream stops the second restock.

The correct pattern already existed two functions away — `markOrderPaidManually`
claims its transition with a conditional `updateMany({ where:{ id, status:
'PENDING_PAYMENT' } })` and gates ALL side effects on `count === 1`. `refundOrder`
and `cancelOrder` simply hadn't adopted it.

**Fix (this round; Python full-file rewrite + tsc gate + diff-vs-backup — Edit
tool truncated the file tail on first attempt, reverted from backup, see Tooling
note):**
1. `cancelOrder`: replaced the unconditional `update` with a conditional claim
   `updateMany({ where:{ id, status:'PENDING_PAYMENT', paymentSubmittedAt:null }, data:{ status:'CANCELED' } })`
   and `if (claim.count !== 1) return;` before the restock loop + notifications.
   The WHERE re-encodes exactly the guards the snapshot checks already enforce
   (PENDING_PAYMENT, no receipt in flight — BUG-035), so the loser of the race
   no-ops cleanly instead of restocking again.
2. `refundOrder`: replaced the unconditional `update` with
   `updateMany({ where:{ id, status:{ not:'REFUNDED' } }, data:{ status:'REFUNDED' } })`
   and `if (flip.count !== 1) return;` before the restock loop + email + notifies.
   The Stripe `refunds.create` call stays ahead of the flip and is itself
   replay-safe (a second call on a fully-refunded intent errors and is caught);
   the atomic flip is what guarantees restock/email fire exactly once, which is
   the sole gate on the manual (no-PI) path.

**Manual-payment posture:** preserved — no Stripe/card/"pay now" copy touched;
the refund email's "to your original payment method" line is unchanged and still
conditional on an actual Stripe PI. No schema change. No Stripe coupling added;
future-Stripe-readiness intact (the Stripe refund block is untouched).

**Build:** `npx tsc --noEmit` exits 0 before and after. `diff` vs
`.backups/bug036-2026-06-20/actions.ts.bak` shows ONLY the two intended
hunks (unconditional `update` → conditional claim + count gate, ×2). File
2688 → 2707 lines; backtick count unchanged at 388 (no new template literals);
file tail (`rejectPayment`) intact (NUL-byte/truncation check = 0).

**Verification:** server-only actions with no browser-testable surface, and
BUG-033 keeps the site unreachable, so this is ⏳ browser-UNVERIFIED. Codified an
offline regression matrix — `scripts/verify-restock-once-guard.ts` — that models
a faithful two-concurrent-clicks race (both requests snapshot the original row
before either write lands) against both the OLD (unconditional `update`) and NEW
(conditional `updateMany` + `count===1` gate) logic. It asserts the NEW paths
restock exactly once (`restockRuns=1`, `stock=+3`, `notifies=1`) while
documenting that the OLD paths double-restock (`restockRuns=2`, `stock=+6`,
`notifies=2`) — the defect reproduced. Runs green via
`node --experimental-strip-types` (exit 0; `npx tsx` still unavailable in the
Linux sandbox — node_modules carries the Windows esbuild binary). The matrix is
sensitive: revert either NEW path to an unconditional update and its restockRuns
flips to 2 → the script exits 1. Re-ran the BUG-034/035 harness too: still exit 0
(no regression).

**Invariant:** S4 annotated in INVARIANTS.md — the cancel/refund restock is now
atomic (conditional-claim + count gate), matching `markOrderPaidManually`.

### Tooling incident this round (recovered) — Edit-tool tail truncation + NUL injection
- First patch attempt via the Edit tool truncated `actions.ts` at the tail
  (the `rejectPayment` function was cut mid-string; `tsc` → TS1005). Reverted
  from `.backups/bug036-2026-06-20/actions.ts.bak` (intact, 2688 lines), then
  re-applied via a Python exact-match full-file rewrite with `os.replace` +
  `fsync` and count-asserted (`==1`) replacements. Same local-FS corruption
  family documented on 2026-06-09 (BUG-027/028) and 2026-06-11.
- The new harness file also picked up 276 trailing NUL bytes on write; stripped
  them (Python `replace(b'\x00',b'')` + atomic rewrite) and re-verified the run.
- Both offline harnesses are `export {}`-marked modules so their top-level
  identifiers don't collide in the shared `**/*.ts` tsconfig program (the new
  file initially clashed with `verify-receipt-in-flight-guards.ts` on
  `OrderStatus`/`failures`/`rows`; marking both as modules cleared it, tsc=0).

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in /admin/settings. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable from any network. BLOCKED on user/infra.

## NEW — 2026-06-25 (round: payment verify/reject atomicity — sibling of S4 cancel/refund)

> No Chrome browser connected this round (`list_connected_browsers` → `[]`),
> so BUG-033 could not be re-probed with a live origin nav; status unchanged
> (deployed site unreachable from the audit browser on every prior probe
> 06-14/15/17/18/19/20). All B1–B17 + every "FIXED (code; browser-unverified)"
> item remain ⏳ UNVERIFIED — no promotion to ✅ browser-VERIFIED is permitted.
> The 2026-05-29 browser-VERIFIED items (S6, N3) stand.
>
> All cataloged genuinely-OPEN items remain BLOCKED on user/infra (013 Stripe
> business, 005 email-verify rollout, 020 notification config, 033
> reachability), so CODE AGENT MODE ran a fresh atomicity sweep adjacent to the
> last three rounds' S4/state-integrity family (BUG-034/035/036) and found the
> last unhardened member of the claim-then-side-effect family.

### NEW BUG-037 · P1 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Financial/State-integrity/Trust · `rejectPayment` is not atomic — races a concurrent verify (PAID→REJECTED corruption) and double-click double-notifies
**File:** `src/app/admin/actions.ts` — `rejectPayment`.

**Symptom / root cause:** `verifyPayment` (the sibling in the verify/reject pair)
correctly claims its transition with a conditional
`updateMany({ where:{ id, paymentVerificationStatus:'AWAITING_VERIFICATION', status:'PENDING_PAYMENT' } })`
inside a `$transaction` and gates ALL side effects on `count===1`, returning a
"Verification race" message otherwise. `rejectPayment` did NOT: it read a
snapshot, checked `paymentVerificationStatus === 'AWAITING_VERIFICATION'` only in
memory, then performed an **unconditional** `prisma.order.update({ where:{ id } })`
and fired buyer notification + buyer email + `notifyAdmins` + audit
unconditionally. Same defect family as BUG-002 (webhook), BUG-035 (cancel) and
BUG-036 (restock): the status precondition lived only in the stale-snapshot `if`,
not in the write's WHERE.

**Impact (two concrete races):**
1. **verify/reject collision (serious).** Two admins (or one double-acting) open
   the same AWAITING_VERIFICATION order; one Verifies, one Rejects. Both snapshot
   reads pass their in-memory guard. `verifyPayment`'s atomic claim flips the
   order to `status=PAID` / `paymentVerificationStatus=VERIFIED`. Then
   `rejectPayment`'s unconditional `update({where:{id}})` lands and overwrites:
   it sets `paymentVerificationStatus=REJECTED`, clears `paymentVerifiedAt` /
   `paymentVerifiedById` and nulls `paymentSubmittedAt` — **but never touches
   `status`, which stays PAID**. Result: a corrupt `status=PAID` +
   `paymentVerificationStatus=REJECTED` order with its verification trail wiped,
   while the buyer receives a *"we need a corrected receipt"* email for an order
   that is actually paid and queued to ship. Violates F15 (verification-status
   monotonicity — VERIFIED must not regress to REJECTED) and the manual-payment
   invariant that verify/reject is the single source of truth on payment state.
   (verifyPayment is itself protected against the reverse order — its atomic
   WHERE requires AWAITING_VERIFICATION, so a reject-then-verify safely no-ops.)
2. **double-click / two-operator reject.** Both unconditional updates succeed →
   buyer gets two "needs attention" emails + two in-app notifications, two audit
   rows, two admin pings (same double-notify class as BUG-036).
   (Also closes a buyer-resubmit-vs-reject race: the WHERE precondition means a
   reject can no longer silently clear a receipt the buyer re-submitted a moment
   earlier.)

**Fix (this round; shell-side Python exact-match replacement, count-asserted = 1,
atomic `os.replace`+`fsync`, diff-vs-backup — Edit tool deliberately NOT used on
source per the documented local-FS tail-truncation hazard):** replaced the
unconditional `update` with
`updateMany({ where:{ id, paymentVerificationStatus:'AWAITING_VERIFICATION', status:'PENDING_PAYMENT' }, data:{…} })`
and added `if (rejectRes.count !== 1) return { ok:false, message:'Rejection race
— another admin already acted on this order (likely verified it). Refresh …' };`
**before** any side effect. The WHERE re-encodes exactly the guards the snapshot
checked, so the loser of any race no-ops cleanly (no overwrite, no email, no
double-notify), symmetric with `verifyPayment`.

**Manual-payment posture:** preserved — no Stripe/card/"pay now" copy touched;
bank-transfer / verify-queue language only. No schema change. No Stripe coupling.
Future-Stripe-readiness intact.

**Build:** `npx tsc --noEmit` exits 0 before and after. `diff` vs
`.backups/bug037-2026-06-25/actions.ts.bak` shows ONLY the one intended hunk
(unconditional `update` → conditional `updateMany` + `count!==1` early-return).
File 2707 → 2723 lines; backtick count unchanged at 388 (no new template
literals); NUL-byte/truncation check = 0; file tail (`rejectPayment` end) intact.

**Verification:** server-only admin action with no browser-testable surface, and
BUG-033 keeps the site unreachable anyway, so ⏳ browser-UNVERIFIED. Codified an
offline regression matrix — `scripts/verify-reject-payment-atomic.ts` — that
models the "both requests snapshot before either write lands" verify/reject race
and a double-click reject against both OLD (unconditional update) and NEW
(conditional updateMany + count gate) logic. It asserts the NEW path loses
cleanly to a concurrent verify (order stays PAID+VERIFIED, `rejectNotifies=0`)
and notifies exactly once on double-click, while documenting that the OLD path
corrupts to PAID+REJECTED and double-notifies (defect reproduced). Runs green via
`node --experimental-strip-types` (exit 0; `export {}`-marked module so it does
not collide with the other two harnesses in the shared `**/*.ts` tsconfig
program). Re-ran the BUG-034/035 and BUG-036 harnesses too — both still exit 0
(no regression).

**Invariant:** F15 annotated in INVARIANTS.md — `rejectPayment` now claims its
transition atomically (conditional-claim + count gate), symmetric with
`verifyPayment`, so the AWAITING_VERIFICATION → REJECTED edge can no longer be
driven by a stale snapshot or race a concurrent VERIFIED.

### Build + tooling this round (2026-06-25)
- `npx tsc --noEmit` exits 0 (green) before and after.
- Source changed: `src/app/admin/actions.ts` (one hunk). New harness:
  `scripts/verify-reject-payment-atomic.ts`. Backups in
  `.backups/bug037-2026-06-25/` (actions.ts, BUGS.md, INVARIANTS.md).
- Edit tool NOT used on source (documented truncation hazard); patched via
  count-asserted shell-side replacement + tsc gate + diff-vs-backup. No
  filesystem-truncation incident observed this round.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in /admin/settings. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable from any network AND a connected Chrome in the run. BLOCKED on user/infra.

## NEW — 2026-06-27 (round: confirmDelivery atomicity — last unhardened order-status mutation)

### NEW BUG-038 · P1 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Financial/State-integrity/Trust · `confirmDelivery` is not atomic — races a concurrent admin refund (REFUNDED->DELIVERED corruption) and double-notifies on double-click

**File:** `src/lib/orders/actions.ts` (buyer-side `confirmDelivery`).

**Summary.** `confirmDelivery` was the one remaining order-status mutation still
using the snapshot-then-unconditional-`update` anti-pattern that the S4/state-
integrity sweep already removed from every admin sibling (`verifyPayment`/
`rejectPayment` BUG-037, `cancelOrder`/`refundOrder` restock BUG-036, cancel
receipt-in-flight BUG-035, `setOrderFulfillment` BUG-026, `markOrderPaidManually`).
It read a snapshot, checked `status === 'SHIPPED'`, then issued an
**unconditional** `prisma.order.update({ where:{ id } , data:{ status:'DELIVERED', deliveredAt } })`
followed by `notifyAdmins` + `audit` — none gated on a claim. Two races:

1. **Cross-action terminal-state regression (the serious one).** `refundOrder`
   claims any non-REFUNDED row (`where:{ id, status:{ not:'REFUNDED' } }`), which
   includes `SHIPPED` (refunding a shipped-then-returned order is a legitimate
   flow). If an admin refunds a SHIPPED order at the same moment the buyer taps
   "Confirm delivery": refund atomically flips SHIPPED->REFUNDED, **restocks the
   unit, and emails "refund issued"**; then the buyer's unconditional write
   overwrites the row back to **DELIVERED**. Result: an order showing DELIVERED
   whose stock was already returned to the catalog and whose money was refunded —
   a terminal-state regression (REFUNDED->DELIVERED) that violates **S3**
   (monotonic, REFUNDED terminal) and **F12** (refunded order must not re-enter an
   active/fulfilled state). The restocked unit can then be oversold.
2. **Buyer double-click / duplicate submit.** Two confirmDelivery requests both
   snapshot SHIPPED, both run the unconditional update -> `deliveredAt` re-stamped
   and `notifyAdmins('ORDER_DELIVERED')` + `audit('order.delivery.confirm')` fire
   **twice** (BUG-036-class double-notify; the manual/no-Stripe path has nothing
   upstream to dedupe).

**Fix.** Unconditional `update` -> conditional
`updateMany({ where:{ id, status:'SHIPPED' }, data:{ status:'DELIVERED', deliveredAt } })`
plus `if (res.count !== 1) { revalidatePath(...); return; }` **before** any side
effect (admin notify + audit). The write now only lands while the row is still
SHIPPED, so a concurrent refund/cancel that already moved it out of SHIPPED makes
this a no-op instead of a regression, and a double-click notifies exactly once.
The pre-existing already-DELIVERED idempotent early-return is unchanged. Symmetric
with the admin siblings; no status field is set anywhere it wasn't before.

**Posture.** Manual-payment safe — no Stripe/card/"pay now" copy touched. No
schema change, no Stripe coupling, future-Stripe-readiness intact.

**Application method.** count-asserted (`==1`) shell-side Python exact-match
byte-replacement + `os.replace`/`fsync`; **Edit tool not used on source** (the
documented local-FS CRLF/tail hazard). First attempt accidentally normalized the
file's CRLF line endings to LF (whole-file diff); caught immediately by
`diff`-vs-backup, reverted from `.backups/bug038-2026-06-27/actions.ts.bak`, and
re-applied in binary mode preserving CRLF. Final `diff` vs backup = the one
intended hunk only. 443 -> 460 lines; backtick-bearing lines 46 -> 47; CRLF
preserved (438 -> 455).

**Verification.** `scripts/verify-confirm-delivery-atomic.ts` (NEW) models both
races against OLD vs NEW: asserts NEW notifies once on double-click, preserves
REFUNDED with zero delivery-notify on the refund race, and still delivers+notifies
once on the happy path; documents OLD double-notifying and corrupting
REFUNDED->DELIVERED. Runs green
(`node --experimental-strip-types scripts/verify-confirm-delivery-atomic.ts` -> exit 0).
`npx tsc --noEmit` -> exit 0 before and after. Prior-round matrices
(verify-reject-payment-atomic, verify-restock-once-guard,
verify-receipt-in-flight-guards) still exit 0 — no regression.
Browser-unverified (buyer-session server action; proper check is a real
SHIPPED-order confirm + concurrent-refund integration run, gated on BUG-033 +
a connected Chrome — neither available this round; `list_connected_browsers` = []).

### Browser audit — none this round
`list_connected_browsers` returned `[]` (no Chrome connected), so BUG-033 could
not be re-probed against a live origin and no "FIXED (code; browser-unverified)"
item — including BUG-038 — may be promoted to browser-VERIFIED. B1-B17 remain
UNVERIFIED.


## NEW — 2026-06-28 (round: expired-event restock-once atomicity — last unhardened order-status mutation)

> Chrome NOT connected this run (`list_connected_browsers` = []) → no browser
> verification possible; BUG-033 could not be re-probed against a live origin.
> Per the hard rule, no "FIXED (code; browser-unverified)" item — including
> BUG-039 below — is promoted to browser-VERIFIED. B1–B17 remain UNVERIFIED.
> `npx tsc --noEmit` exits 0 before and after. No filesystem-truncation incident;
> Edit tool NOT used on source (shell-side count-asserted byte replacement only).
> Backups: `.backups/bug039-2026-06-28/`.

### NEW BUG-039 · P1 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Financial/State-integrity · Stripe `checkout.session.expired` restock is not atomic — a redelivered expired event can double-release stock (invariants F4 / S4)

**File:** `src/app/api/stripe/webhook/route.ts` (the `checkout.session.expired` branch).

**Summary.** This was the **last** order-status mutation still using the
snapshot-then-unconditional-`update` anti-pattern that the S3/S4 state-integrity
sweep already removed from every sibling (BUG-002 webhook PAID idempotency,
BUG-026 `setOrderFulfillment`, BUG-035 cancel receipt-in-flight, BUG-036 restock-
once, BUG-037 `rejectPayment`, BUG-038 `confirmDelivery`). The expired branch
read the order, checked `existing.status === 'PENDING_PAYMENT'` **in memory**,
then issued an **unconditional** `order.update({where:{id}})` to CANCELED followed
by an **unconditional** per-item `product.update({quantity:{increment}})` restock —
none of it gated on a claim.

**Impact (race).** Stripe redelivers webhooks on network blips / 5xx. Two
`expired` deliveries for the same order that both snapshot `PENDING_PAYMENT`
before either write lands both pass the in-memory guard and both run the restock
loop → **the same units are returned to the catalog twice** (oversell risk), and
the order is "canceled" twice (double work / double any future side effect).
Violates **F4** (release stock once) and **S4** (cancelling an order returns stock
once and only once). NOTE: this path is **dead under the official manual-payment
posture** (Stripe is not configured on production — BUG-013), so there is no
production impact today; it is hardened because it is Stripe-path code the owner
wants kept future-ready, and leaving the last instance of the anti-pattern in the
tree is an avoidable latent defect the moment Stripe is switched on.

**Fix.** Unconditional `update` + unconditional restock →
`const claim = await prisma.order.updateMany({ where:{ id: orderId, status:'PENDING_PAYMENT' }, data:{ status:'CANCELED' } })`
with the restock loop gated behind `if (claim.count === 1) { … }`. Only the writer
that actually flips PENDING_PAYMENT→CANCELED releases stock; a redelivered event
(row already CANCELED/PAID) claims zero rows and no-ops. Symmetric with every
admin/buyer sibling. No status field set anywhere it wasn't before.

**Posture.** Manual-payment safe — no Stripe/card/"pay now" copy touched (this is
webhook server logic, no UI). No schema change. Future-Stripe-readiness intact
(it makes the Stripe path *more* correct, not less).

**Application method.** Shell-side Python exact-match byte replacement,
count-asserted (`==1`), `os.replace`+`fsync`; **Edit tool not used on source**
(documented local-FS truncation hazard). File is LF; no CRLF introduced
(`grep -c $'\r'` = 0). `diff` vs `.backups/bug039-2026-06-28/route.ts.bak` = the
one intended hunk only.

**Verification.** `scripts/verify-expired-restock-once.ts` (NEW) models the
double-delivery race against OLD (unconditional) vs NEW (atomic claim + count
gate): asserts NEW releases stock exactly once and cancels once, never restocks a
PAID/CANCELED order, and documents OLD double-restocking the same units. Runs
green (`node --experimental-strip-types … ` → exit 0; `export {}`-marked so it
shares the `**/*.ts` program cleanly). `npx tsc --noEmit` → exit 0 before and
after. Prior matrices (verify-confirm-delivery-atomic, verify-reject-payment-
atomic, verify-restock-once-guard, verify-receipt-in-flight-guards) still exit 0 —
no regression. Browser-unverified (BUG-033 + no connected Chrome).

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable AND a connected Chrome in the run. BLOCKED on user/infra.


## NEW — 2026-06-30 (round: archive/unarchive audit-idempotency — last snapshot-then-unconditional admin mutation, non-status sibling of BUG-010)

> Chrome connectivity this run: `list_connected_browsers` returned **2 browsers**
> ("Browser 1", "Browser 2", both local Windows). But selecting one for an audit
> requires interactive user browser-selection (the tool mandates listing every
> connected browser and a human clicking the right one) — impossible in an
> unattended scheduled run. So no real-browser session was exercised. BUG-033 was
> re-probed via an independent `web_fetch https://labtodate.com/`, which again
> returned an **empty body** → deployed origin still unreachable. Per the hard
> rule, no "FIXED (code; browser-unverified)" item is promoted to browser-VERIFIED;
> B1–B17 remain UNVERIFIED. `npx tsc --noEmit` exits 0 before and after. Edit tool
> NOT used on source (shell-side count-asserted byte replacement only).
> Backups: `.backups/bug040-2026-06-30/`.

### Adversarial re-audit result — BUG-039's "last order-status mutation" claim CONFIRMED

Swept every `prisma.order.(update|updateMany)` call site in `src/`. Every order
**status transition** now goes through an atomic `updateMany` claim with side
effects gated on `count === 1` (webhook PAID/expired, payment verify/reject,
cancel/refund restock, setOrderFulfillment, confirmDelivery, markOrderPaidManually,
cron sweeps). The only two remaining unconditional `order.update({…status:'CANCELED'})`
calls are the **Stripe-`sessions.create`-throw rollback paths**
(`src/lib/orders/actions.ts:452`, `src/lib/cart/actions.ts:266`): they cancel an
order created microseconds earlier in the SAME request, before `stripeSessionId`
is even set, so no concurrent actor can race them — correctly classified F6 (and
dead under manual posture). **No missed status-mutation instance.** The atomicity
sweep on order status is genuinely complete.

### NEW BUG-040 · P3 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Audit-integrity · `archiveOrder` / `unarchiveOrder` are not idempotent — a concurrent double-click re-stamps `archivedAt` and double-fires the audit log

**File:** `src/app/admin/actions.ts` (`archiveOrder`, `unarchiveOrder`).

**Summary.** These two admin soft-archive actions were the remaining order
mutations still using the snapshot-then-unconditional-write + unconditional
`audit()` anti-pattern — the same shape BUG-010 removed from `setOrderFulfillment`
("kills audit ×17") and the S3/S4 sweep removed from every status mutation. Each
read a snapshot, checked `if (o.archivedAt) return 'already archived'`, then issued
an **unconditional** `prisma.order.update({where:{id}})` followed by an
**unconditional** `audit('order.archive'|'order.unarchive', …)`. Two concurrent
requests (admin double-click / duplicate submit) both pass the in-memory guard,
both write, and both audit.

**Impact.** Low (P3): no money, no stock, no buyer-facing notification — `archivedAt`
gets re-stamped to the later click's timestamp and the audit log gains a duplicate
`order.archive`/`order.unarchive` entry per extra click. It is audit-trail noise +
timestamp drift, the BUG-010 class, not a financial/state-integrity defect. Hardened
to finish the idempotency sweep and to keep the audit log a faithful 1:1 record of
operator intent.

**Fix.** Keep the friendly fast-path guard (for the "not found" / instant message),
then replace the unconditional `update` with an atomic claim:
`updateMany({ where:{ id, archivedAt: null }, data:{ archivedAt: new Date(), archivedById } })`
(archive) / `updateMany({ where:{ id, archivedAt: { not: null } }, … })` (unarchive),
and gate `audit()` + the success return on `count === 1`. A request that loses the
race claims zero rows and returns the idempotent "already archived" / "not archived"
message **without** auditing. Symmetric with every other order mutation.

**Posture.** Manual-payment safe — no Stripe/card/"pay now" copy touched (admin
archive is unrelated to payment). No schema change, no Stripe coupling,
future-Stripe-readiness intact. Not a drive-by refactor: the change is confined to
the two functions and applies the exact established sweep pattern.

**Application method.** Shell-side Python exact-match byte replacement,
count-asserted (`==1` per hunk), `os.replace`+`fsync`; **Edit tool not used on
source** (documented local-FS truncation/CRLF hazard). File is LF; no CRLF
introduced (`grep -c $'\r'` = 0). `diff` vs `.backups/bug040-2026-06-30/actions.ts.bak`
= the two intended hunks only. 2722 → 2738 lines.

**Verification.** `scripts/verify-archive-idempotent.ts` (NEW) models the
double-click race against OLD (unconditional) vs NEW (atomic claim + count gate):
asserts NEW archives/unarchives + audits exactly once, never audits an
already-archived/not-archived row, and documents OLD double-auditing. Runs green
(`node --experimental-strip-types scripts/verify-archive-idempotent.ts` → exit 0).
`npx tsc --noEmit` → exit 0 before and after. All five prior matrices
(verify-expired-restock-once, verify-confirm-delivery-atomic,
verify-reject-payment-atomic, verify-restock-once-guard,
verify-receipt-in-flight-guards) still exit 0 — no regression. Browser-unverified
(admin-session server action; proper check is a seeded concurrent double-submit
integration run, gated on BUG-033 + a connected, selectable Chrome).

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — business decision; manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability confirmation + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability) — keystone; blocks B1–B17 + all browser-unverified promotions. Needs the deployed site reachable AND a connected Chrome that can be selected without interactive prompts. BLOCKED on user/infra.

---

## Round 2026-06-30 (round2) — extend the idempotency sweep beyond order-status

### Sweep result — two more compare-and-set gaps found (NOT order-status)
Last round declared the **order-status** atomicity sweep complete (BUG-039/040) and
that claim still holds. This round swept the **non-order status mutations** that
share the same BUG-010/040 shape (snapshot read → unconditional `update` →
unconditional `audit()`/`notify`). Two were still on the old anti-pattern:
`setQuoteStatus` (`src/lib/quotes/actions.ts`) and `setTicketStatus`
(`src/lib/support/actions.ts`). Filed together as BUG-041.

### NEW BUG-041 · P2 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · State-integrity/Trust · `setQuoteStatus` & `setTicketStatus` are not atomic — a double-click re-stamps state, double-audits, and (quote ACCEPT) double-notifies the buyer

**Files:** `src/lib/quotes/actions.ts` (`setQuoteStatus`), `src/lib/support/actions.ts`
(`setTicketStatus`).

**Summary.** Both functions read a snapshot, then issued an **unconditional**
`update({where:{id}})` followed by an **unconditional** `audit('quote.status' |
'ticket.status', …)`. Neither had any source-state guard at all — not even an
in-memory `if (status === current) return`. So:
- A double-click / duplicate-submit / stale-tab re-submit wrote the same status
  again, re-stamped `archivedAt` on the CLOSE→auto-archive branch, and emitted a
  duplicate `*.status` (and `*.archive`) audit entry per extra click.
- `setQuoteStatus` is worse than the P3 BUG-040 class because the ACCEPT branch
  then fires **buyer-facing** `notifyUser` + `notifyAdmins`. A buyer double-clicking
  "Accept" got duplicate "Quote accepted — order …" notifications and admins got
  duplicate "Quote accepted → order …" alerts. That buyer-facing duplicate is why
  this is rated **P2**, not P3.

**Impact.** No direct money/stock movement (the materialized Order is separately
protected by the S3/S4 atomic sweep), so not P0/P1 — but it is audit-trail
corruption + `archivedAt` timestamp drift + duplicate buyer/admin notifications,
i.e. a trust/state-integrity defect on the two buyer-facing workflows.

**Fix.** Established sweep pattern — atomic compare-and-set + count gate:
- `updateMany({ where: { id, status: { not: status } }, data: { status } })`
  (and, on the CLOSE→auto-archive branch, the where broadens to
  `{ id, OR: [{ status: { not: status } }, { archivedAt: null }] }` so a legacy
  CLOSED-but-unarchived row still gets archived on a single click — no behavior
  regression).
- `const changed = claim.count === 1` gates `audit()`, `notifyUser`,
  `notifyAdmins`. A `statusChanged = snap.status !== status` flag additionally
  suppresses a "X → X" status-audit on the pure-archive path.
- The ACCEPT-path `redirect(/app/orders/<n>/payment)` is kept **unconditional** so
  a buyer who re-accepts (lost the race / stale tab) still lands on their payment
  workspace — idempotent UX — they just don't re-trigger notifications.
- `setTicketStatus` returns a friendly idempotent `Already <status>.` message when
  `count === 0`.

**Posture.** Manual-payment safe — no Stripe/card/"pay now" copy touched (quote
ACCEPT already routes to the manual bank-transfer payment workspace; that wording
is unchanged). No schema change, no Stripe coupling, future-Stripe-readiness intact.
Confined to the two functions — not a drive-by refactor.

**Application method.** Shell-side Python exact-match byte replacement, count-asserted
(each hunk `== 1`), `os.replace`+`fsync`; **Edit tool not used on source** (documented
BUG-027 local-FS truncation/CRLF hazard). Both files are LF; `grep -c $'\r'` = 0
after patch. `diff` vs `.backups/bug041-2026-06-30/{quotes,support}-actions.ts.bak`
= the intended hunks only.

**Verification.** `scripts/verify-status-transition-atomic.ts` (NEW) models the
double-click race OLD vs NEW: asserts NEW writes/audits/notifies exactly once,
never on an already-in-target row, redirect stays reachable on re-accept, and the
legacy CLOSED-unarchived single-click still archives. Runs green
(`node --experimental-strip-types …` → exit 0). `npx tsc --noEmit` → exit 0 before
and after. All six prior matrices still exit 0 — no regression. Browser-unverified
(admin/buyer-session server actions; proper check is a seeded concurrent
double-submit against real sessions, gated on BUG-033 + a non-interactively-selectable
Chrome).

### Note (not a code change this round) — terminal-transition policy
`setQuoteStatus`/`setTicketStatus` still allow any role-permitted status change
regardless of the *current* state (e.g. an admin could DECLINE/CLOSE a quote that
is already ACCEPTED with an order in flight). The atomic fix makes each transition
idempotent but does **not** add a state-machine guard forbidding such transitions,
because which transitions are legal is a **business decision** (admins legitimately
close abandoned-but-accepted quotes). Flagged for a product decision rather than
guessed at. No money/stock risk: the materialized Order's own status is independently
protected by the S3/S4 atomic sweep.

### BUG-033 re-probe (2026-06-30 round2) — still unreachable, still blocked
`web_fetch https://labtodate.com/` returned an empty body again (no served
document). `list_connected_browsers` → 2 local Windows Chrome instances ("Browser 1",
"Browser 2"), but selecting one requires an interactive AskUserQuestion prompt that
cannot be answered in an unattended scheduled run, and the site is unreachable
regardless. No browser audit possible; no promotion of any browser-unverified item.
BUG-033 remains **OPEN / BLOCKED** (keystone).

### Build + tooling this round (2026-06-30 round2)
- `npx tsc --noEmit` → exit 0 (before and after).
- All seven offline matrices exit 0 (six prior + new verify-status-transition-atomic).
- No filesystem-truncation incident. Backups: `.backups/bug041-2026-06-30/`.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability) — keystone; needs the deployed site reachable AND a non-interactively-selectable Chrome. BLOCKED on user/infra.

## NEW — 2026-07-02 (round: SLA-breach sweep atomicity — BUG-042)

> Chrome not interactively selectable in this unattended run (2 local Windows
> instances present, selection needs a prompt that can't be answered) and the
> deployed site is unreachable (`web_fetch https://labtodate.com/` → empty body),
> so BUG-033 remains OPEN/BLOCKED and no browser-unverified item can be promoted.
> `npx tsc --noEmit` → exit 0 before and after. All eight offline matrices exit 0
> (seven prior + new `verify-sla-breach-once.ts`). One truncation incident during
> the edit (file cut at line 287 mid-string) was caught by post-edit backtick/tail
> integrity checks and fully recovered from `.backups/bug042-2026-07-02/route.ts.bak`;
> the fix was then re-applied deterministically and re-verified.

### NEW BUG-042 · P2 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Reliability/Trust · SLA-breach sweep is not atomic — overlapping cron runs double-notify/double-email/double-audit a single breach
**File:** `src/app/api/cron/sla-sweep/route.ts` (support-ticket sweep + quote sweep)
**Defect family:** same as BUG-002 (webhook), BUG-026 (`setOrderFulfillment`),
BUG-035/036/037/038/039 (order-status atomic claims), BUG-040 (`archiveOrder`),
BUG-041 (`setQuoteStatus`/`setTicketStatus`). This was the **last unguarded write
path in the cron** — the proforma-expiry and orphan-order sweeps in the very same
file were already hardened with `updateMany` + `count===1` gates; the two
SLA-breach stampers were not.

**Root cause:** each SLA loop did `findMany({ where: { slaBreachAt: null, ... } })`
then, per row, a plain `update({ where: { id } })` followed by UNCONDITIONAL
`notifyUser`/`notifyAdmins` + `sendEmail` + `audit`. The `slaBreachAt=null`
precondition lived only in the stale `findMany` snapshot, not in the write's WHERE.

**Trigger:** the route is exported for **both POST and GET** (GET calls POST — "for
ease of triggering from a sidecar's wget"), and a slow sweep can still be running
when the next scheduled tick fires. Two overlapping invocations both read the same
`slaBreachAt=null` ticket/quote before either write lands → both stamp, both
notify, both email the assignee, both audit.

**Impact:** duplicate SLA-breach in-app notifications, duplicate `[SLA] … overdue`
emails to the assignee, and duplicate `ticket.sla.breach` / `quote.sla.breach`
audit rows. No money/stock/Stripe impact; manual-payment posture untouched. Class:
notification-noise + audit-integrity (P2, same tier as BUG-040/041).

**Fix:** replace both plain `update`s with an atomic claim —
`updateMany({ where: { id, slaBreachAt: null }, data: { slaBreachAt: now } })` —
and `if (claim.count !== 1) continue;` so only the invocation that actually flips
the row from null fires the notify/email/audit side effects. Byte-for-byte the same
posture already used by the proforma/orphan sweeps below it. `ticketsNotified` /
`quotesNotified` now reflect *actual* (deduped) notifications.

**Verification.** `scripts/verify-sla-breach-once.ts` (NEW) models two overlapping
sweeps OLD vs NEW: asserts NEW stamps+notifies exactly once under the race and zero
on an already-breached row; documents OLD double-notifying (got=2). Runs green
(`node --experimental-strip-types` → exit 0). `npx tsc --noEmit` → exit 0 before and
after. All seven prior matrices still exit 0 — no regression. Browser-unverified
(needs a seeded overlapping GET+POST trigger against a reachable deployment — gated
on BUG-033).

**Not covered / flagged:** the SLA `sendEmail` calls remain best-effort
(`.catch(() => null)`) with no delivery-dedupe of their own; the atomic breach
claim upstream is what now guarantees a single send per breach. No separate email
idempotency layer was added (would need a delivery ledger — out of scope, no user
impact given the claim gate).

### BUG-033 re-probe (2026-07-02) — still unreachable, still blocked
`web_fetch https://labtodate.com/` returned an empty body again (no served
document). No non-interactive Chrome selection available in a scheduled run. No
browser audit possible; no promotion of any browser-unverified item. BUG-033
remains **OPEN / BLOCKED** (keystone).

### Build + tooling this round (2026-07-02)
- `npx tsc --noEmit` → exit 0 (before and after).
- All eight offline matrices exit 0 (seven prior + new verify-sla-breach-once).
- Truncation incident on `sla-sweep/route.ts` caught and recovered; backup at
  `.backups/bug042-2026-07-02/`.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability) — keystone; needs the deployed site reachable AND a non-interactively-selectable Chrome. BLOCKED on user/infra.
- Recurring: `.git/index.lock` (0 bytes, 2026-06-13) still present; sandbox cannot delete it. **Needs from user:** delete `.git\index.lock` and find what keeps recreating it.

## NEW — 2026-07-03 (round: refund status precondition — BUG-043)

> No connected Chrome this run (`list_connected_browsers` → `[]`; prior runs saw 2
> local Windows instances, this run zero) and the deployed site is unreachable
> (`web_fetch https://labtodate.com/` → empty body), so BUG-033 remains OPEN/BLOCKED
> and no browser-unverified item can be promoted. `npx tsc --noEmit` → exit 0 before
> and after. All nine offline matrices exit 0 (eight prior + new
> `verify-refund-status-guard.ts`). One filesystem-truncation incident during the
> edit (source cut mid-string at line ~2733, leaving an unterminated template
> literal / odd backtick count) was caught by post-edit backtick+tail integrity
> checks and fully recovered: restored `.backups/bug043-2026-07-03/actions.ts.bak`,
> re-applied the two hunks deterministically via a Python `os.replace`+`fsync`
> atomic write (Edit tool avoided on source, per the standing BUG-027 hazard note),
> then re-verified tsc + all matrices green.

### NEW BUG-043 · P3 · FIXED (code; tsc-green + offline-logic-verified, browser-unverified) · Data-integrity/Inventory · `refundOrder` uses a negative status guard — can double-restock a CANCELED order / false-refund a PENDING_PAYMENT order
**File:** `src/app/admin/actions.ts` → `refundOrder`
**Defect family:** precondition-not-re-encoded-in-the-write, same class as BUG-035/
036/037/038 and BUG-040/041/042 — but here the gap is a **negative** status guard
(`status: { not: 'REFUNDED' }`) rather than a missing one. `refundOrder` was the
last money-mutating server action in the file that did not positively allow-list
its source statuses in the write's WHERE; every sibling (`cancelOrder`,
`markOrderPaidManually`, `verifyPayment`, `rejectPayment`) does.

**Root cause:** the snapshot guard only returned early on `status === 'REFUNDED'`,
and the atomic flip matched `status: { not: 'REFUNDED' }`. That set matches
`CANCELED`, `PENDING_PAYMENT`, `AWAITING_VERIFICATION`-bearing `PENDING_PAYMENT`,
etc. — every non-refunded row, not just money-captured ones. Restock (`increment`)
and the buyer "refund processed to your original payment method" email were gated
only on that over-broad flip.

**Trigger / impact (if reached):**
- On a **CANCELED** order (already restocked by `cancelOrder` or the proforma-expiry
  sweep): the flip matches → status → REFUNDED and stock is incremented **again** →
  phantom inventory of a unique/used unit → the exact oversell hazard the reserve
  logic (`orders/actions.ts` "so the same used item can't be sold twice") exists to
  prevent.
- On a **PENDING_PAYMENT** order (no money captured): stamps REFUNDED and emails the
  buyer a "refund to your original payment method" for a payment that never landed,
  and pollutes refund/revenue reporting.

**Reachability / severity:** classed **P3** because it is **not currently reachable
through the shipped UI** — `OrderRow.canRefund` gates the Refund button to
PAID/PROCESSING/SHIPPED/DELIVERED, and a PAID-family order cannot transition into a
restock-already state (`cancelOrder` throws on paid orders; the cron only cancels
PENDING_PAYMENT). It is reachable by a stale/direct server-action POST from an
operator holding `orders:refund`, or by any future caller of `refundOrder`. So this
is a latent defense-in-depth + consistency fix, not a live exploit — recorded
honestly as such.

**Fix:** introduce `const REFUNDABLE = ['PAID','PROCESSING','SHIPPED','DELIVERED']
as const;` and (a) snapshot-guard `if (!REFUNDABLE.includes(order.status)) return;`
before the Stripe call/restock/email, and (b) re-encode it in the write:
`updateMany({ where: { id, status: { in: [...REFUNDABLE] } }, data: { status:
'REFUNDED' } })`, keeping the existing `count===1` gate on restock + notifications.
Already-REFUNDED is subsumed by the positive guard (idempotent no-op). Stripe refund
path untouched (only runs when `stripePaymentIntentId` exists) — future-Stripe-ready
and manual-payment-posture-safe; no schema/Stripe/UI-copy change.

**Verification.** `scripts/verify-refund-status-guard.ts` (NEW) models OLD vs NEW
across PAID / already-REFUNDED / CANCELED / PENDING_PAYMENT / PROCESSING / SHIPPED /
DELIVERED: asserts NEW refunds a captured order exactly once, no-ops on CANCELED and
PENDING_PAYMENT, stays idempotent on REFUNDED, and documents OLD double-restocking
CANCELED (qty=1 from 0) and false-refunding PENDING_PAYMENT. `node
--experimental-strip-types` → exit 0. `npx tsc --noEmit` → exit 0 before and after.
All eight prior matrices still exit 0 — no regression. Browser-unverified (a real
promotion needs a seeded direct-POST against a reachable deploy — gated on BUG-033).

### BUG-033 re-probe (2026-07-03) — still unreachable, still blocked
`web_fetch https://labtodate.com/` returned an empty body again (no served
document). `list_connected_browsers` → `[]` (no Chrome extension connected this
run). No browser audit possible; no promotion of any browser-unverified item.
BUG-033 remains **OPEN / BLOCKED** (keystone).

### Build + tooling this round (2026-07-03)
- `npx tsc --noEmit` → exit 0 (before and after).
- All nine offline matrices exit 0 (eight prior + new verify-refund-status-guard).
- Truncation incident on `admin/actions.ts` caught and recovered; backup at
  `.backups/bug043-2026-07-03/`.

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability) — keystone; needs the deployed site reachable AND a connected/non-interactively-selectable Chrome. BLOCKED on user/infra.
- Recurring: `.git/index.lock` (0 bytes, 2026-06-13) still present; sandbox cannot delete it. **Needs from user:** delete `.git\index.lock` and find what keeps recreating it.

## Round 2026-07-09 — BUG-044 (SLA-sweep proforma-expiry not overlap-safe)

### BUG-044 · P2 · FIXED (code; browser-unverified) · Reliability/UX-Trust · Proforma-expiry sweep double-emails/notifies/audits on overlapping runs
**File:** `src/app/api/cron/sla-sweep/route.ts` — proforma-expiry section (~L133-248)

**Symptom:** The proforma-expiry sweep closes an expired `RESPONDED` sourcing
request (→ CLOSED / Lost), cancels its linked `PENDING_PAYMENT` order, then emails
the buyer "your proforma has expired" + notifies the buyer in-app + notifies admins
+ writes an audit row. The close was an **unconditional** `sourcingRequest.update({where:{id}})`
and **none of the side effects were gated** on this invocation actually being the
one that performed the close.

**Root cause:** Same overlap hazard BUG-042 fixed for the ticket + quote sweeps in
this exact route, but the proforma sweep was missed. The route serves both `GET`
and `POST` (a sidecar `wget` hits GET → POST), and a slow sweep can still be running
when the next scheduled tick fires. Two overlapping invocations both `findMany` the
same `RESPONDED` proforma **before either commits**, so both pass the in-memory
filter, both run the transaction (2nd close is a no-op-effect overwrite, 2nd order
`updateMany` matches `count=0` but the code never checked it), and **both fan out the
buyer expiry email + notifications + audit** → the buyer receives the "expired" email
twice, ops gets duplicate pings, and the audit log double-counts one expiry.

**Reachability / severity:** Requires concurrent/overlapping sweep invocations
(GET+POST sidecar, or a sweep overrunning a tick) AND an expired proforma in the same
window. No money movement, no stock effect (quote-materialised orders never reserve
stock — confirmed: no `decrement` in `src/lib/quotes/actions.ts`; the sweep correctly
does not restock), no data corruption — purely duplicate buyer-facing email +
duplicate notifications + audit noise. Classed **P2**, matching BUG-042's severity.

**Fix:** Claim the `RESPONDED → CLOSED` transition **atomically** — the close is now
`tx.sourcingRequest.updateMany({where:{id, status:'RESPONDED'}, data:{status:'CLOSED'}})`;
`if (claim.count !== 1) return;` inside the transaction and a `won` flag + `if (!won) continue;`
after it, so an overlapping loser bails **before** the order cancel and **before** any
buyer-facing side effect. A single expiry now emails/notifies/audits exactly once.
Mirrors the orphan sweep's `canceled` flag and the ticket/quote sweeps' `claim.count`
gate. The receipt-in-flight guard (`paymentInFlight` findFirst + `paymentSubmittedAt:null`
in the cancel WHERE, from BUG-034) is preserved untouched. No schema / Stripe / copy
change; manual-payment posture intact; future-Stripe-ready.

**Verify (browser, when BUG-033 clears):** with a reachable deploy + connected Chrome,
issue a proforma with a short TTL, let it expire, trigger the sweep twice back-to-back
(GET then POST) and confirm the buyer inbox shows a single "proforma expired" email and
the audit log a single `quote.proforma.expire` row. Until then: **code fix present,
browser-unverified.**

### Regression matrix — NEW `scripts/verify-proforma-expiry-once.ts`
Pure in-memory model of two overlapping sweeps. Asserts OLD double-emails/notifies/audits
a single expiry; NEW fires each exactly once; a receipt-in-flight proforma is skipped by
both; sequential re-sweep after CLOSED is a no-op; the happy-path single sweep cancels the
linked order once and leaves the receipt-in-flight order untouched.
`node --experimental-strip-types` → exit 0.

### Build + tooling this round (2026-07-09)
- `npx tsc --noEmit` → **exit 0** (after fixes). It first surfaced a pre-existing
  build-hygiene gap: `scripts/verify-refund-status-guard.ts` (added 2026-07-03) was the
  **lone non-module** matrix, so its global `Status`/`Order` merged with the new matrix's
  global `OrderStatus`/`Order` under the project tsconfig (`isolatedModules`, `**/*.ts`).
  Aligned it with the suite convention by adding `export {};` (one line; makes it a module,
  file-locals its types). No logic change. All 10 matrices exit 0.
- **Truncation incident (recurred):** the file-edit tool truncated
  `src/app/api/cron/sla-sweep/route.ts` (lost the orphan-sweep tail + `GET` export) and
  `scripts/verify-proforma-expiry-once.ts` mid-write — same class as the 2026-07-03
  `admin/actions.ts` incident. Both recovered by re-applying the change deterministically
  via a Python `os.replace`+`fsync` atomic write from the pre-change backup; brace-balance
  and `tsc` re-verified to 0. Backups at `.backups/bug044-2026-07-09/`.

### BUG-033 re-probe (2026-07-09) — still unreachable, still blocked
`web_fetch https://labtodate.com/` returned an empty body again (no served document).
No Chrome extension connected this scheduled run (no interactive grant possible in an
unattended task). No browser audit possible; **no promotion** of any browser-unverified
item (BUG-001/002/004/011/012/014/019/031/034-044 stay FIXED-code / browser-unverified).
BUG-033 remains **OPEN / BLOCKED** (keystone).

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability + connected Chrome) — keystone. BLOCKED on user/infra.
- Recurring: `.git/index.lock` (0 bytes, 2026-06-13) still present; sandbox cannot delete it. **Needs from user:** delete `.git\index.lock` and find what keeps recreating it.

## Round 2026-07-12 — BUG-045 (checkout reserves stock it can never give back)

### BUG-045 · P1 · FIXED (code; browser-unverified) · Data-integrity/Revenue · Reserved stock is leaked permanently when order-create throws
**Files:** `src/lib/orders/actions.ts::startCheckoutWithAddress` (~L329-395),
`src/lib/cart/actions.ts::startCartCheckoutWithAddress` (~L136-215),
new `src/lib/orders/stock.ts`

**Symptom:** Both checkout paths atomically RESERVE stock
(`product.updateMany({where:{id, quantity:{gte:n}}, data:{quantity:{decrement:n}}})`)
**before** calling `createOrderWithUniqueNumber`. If that create throws, the
reservation is never rolled back — and because **no Order row was ever written**,
nothing in the system can give the stock back. `cancelOrder`, `refundOrder` and the
orphan sweep all restock by walking an *order's* items; with no order, they have
nothing to walk. The units are simply gone from inventory until someone edits the
DB by hand.

**Root cause:** The reserve→create sequence had no compensating action around the
create. Note the asymmetry that hid it: the *Stripe*-failure path immediately
below the create **does** compensate (increments the stock back and cancels the
order), and the cart's *partial-reservation* branch **does** compensate. The create
itself — the one step between the two — was the only uncompensated failure point,
so a code reader sees rollbacks on both sides of it and assumes it's covered.

**How the create actually fails (not hypothetical):**
- `createOrderWithUniqueNumber` retries `generateOrderNumber()` on P2002 collisions
  and, after 6 attempts, `throw new Error('Could not allocate an order number')`.
- Any transient DB/connection error (pool exhaustion, failover, restart) inside
  `prisma.order.create` — the very conditions under which retries and blips cluster.
- The create writes the Order **and** its nested `items` — a bigger, slower write
  than the single-row reservation that precedes it, so it is the more likely of the
  two to be the one that dies.

**Impact:**
- **Permanent phantom stock deficit.** `quantity` is decremented with no order to
  reverse it. Irreversible without manual SQL.
- **On this marketplace, `quantity` is routinely 1** (used lab equipment, unique
  units). One transient DB blip during checkout therefore flips a live listing to
  `quantity: 0` — and `/checkout/[slug]` `notFound()`s on `quantity < 1` while the
  marketplace treats 0 as sold out. The listing becomes **permanently unbuyable**.
- **Silent.** The buyer sees a 500 and assumes "didn't go through" — which is true
  of the order but false of the inventory. Nobody is told the stock moved. The
  seller's item just quietly stops selling.
- **Cart multiplies it:** one failed create leaks *every* reserved line in the cart.
- Revenue loss is unbounded-but-quiet: the listing is still visible, still indexed,
  and simply never converts again.

**Reachability / severity:** Requires the order-create to throw — an infrastructure
event, not something a buyer can trigger at will, so **not P0**. But the consequence
is silent, permanent, un-self-healing data corruption on the money path with direct
revenue loss, and the failure mode clusters exactly when the DB is already unhappy
(i.e. it will hit several buyers at once, not one). Rated **P1**.

**Fix:** New `src/lib/orders/stock.ts::releaseReservedStock(reserved, where)` — the
compensating action for the reserve→create window. Both paths now wrap the create in
`try/catch`: on throw, release the reservation, `logError`, and redirect the buyer to
a **recoverable** `?err=order` instead of a 500. Two deliberate properties of the
helper:
1. **It never throws.** It runs on the failure path, immediately before a
   `redirect()`. A throw there would replace a recoverable "couldn't create your
   order, try again" with an unhandled 500 **and still leak the stock** — strictly
   worse than the bug. Each restore is attempted independently; failures are logged
   (that is real drift an operator must reconcile), never propagated.
2. **It uses `updateMany`, not `update`.** `update({where:{id}})` throws P2025 if the
   product row was hard-deleted between reserve and rollback; in a plain loop, one
   missing row **aborts the restore of every remaining item in the cart** — inside the
   block whose entire job is to give stock back. `updateMany` no-ops (count 0) on a
   missing row so the rest of the cart is still released. (This was a live latent bug
   in the two *existing* rollback loops too; both now route through the helper.)

The cart is deliberately still cleared only **after** a successful create, so a buyer
who hits this can simply retry — which is what the new banner tells them.

**Copy (manual-payment posture preserved):** the two `?err=order` banners say
*"We couldn't create your order. Nothing was reserved and no payment is due."* No
Stripe, no "credit card", no "pay now" — bank-transfer posture intact. The banner is
not cosmetic: without it the buyer is bounced back to a pristine-looking form with no
statement of whether they now owe money.

**Verify (browser, when BUG-033 clears):** force the create to fail (temporarily
point `createOrderWithUniqueNumber` at a bad table / kill the DB mid-POST), submit
both checkout forms, and confirm (a) `product.quantity` is back to its pre-checkout
value, (b) no Order row was written, (c) the buyer lands on `?err=order` with the
banner rather than a 500, and (d) the listing is still buyable on retry. Until then:
**code fix present, browser-unverified.**

### Regression matrix — NEW `scripts/verify-checkout-stock-rollback.ts`
Pure in-memory model of both checkout paths. Asserts: OLD leaks the unit forever on a
failed create (single) and leaks *every* cart line (cart), with no Order row for any
sweep to restock from; NEW fully restores stock, writes no phantom order, does not
clear the cart, and returns a recoverable `?err=order`; NEW is a no-op on the happy
path (sold stock stays decremented, cart clears only after a successful create); the
OLD bare-`update` rollback throws P2025 on a concurrently-deleted product and aborts
mid-loop, leaking the remaining items, while the NEW helper never throws and restores
the rest; malformed lines (empty id, zero qty) are skipped rather than corrupting
stock. `node --experimental-strip-types` → exit 0.

### Build + tooling this round (2026-07-12)
- `npx tsc --noEmit` → **exit 0** (clean before and after).
- **All 11 offline matrices exit 0** (ten prior + new verify-checkout-stock-rollback).
- `npx eslint` on the five changed files → 0 errors (1 pre-existing `_subtotal`
  unused-var warning in the dormant `_legacyStripeCartHandoff`; untouched).
- **Truncation incident (recurred, 3rd time):** the file-edit tool truncated all four
  edited files mid-write (`orders/actions.ts` cut inside a string literal,
  `cart/actions.ts` inside a comment, both checkout pages inside JSX) — same class as
  the 2026-07-03 `admin/actions.ts` and 2026-07-09 `sla-sweep/route.ts` incidents.
  Detected by `tsc` (TS1002/TS1005/TS17008), recovered by restoring the pre-change
  backups and re-applying every edit deterministically via a Python
  `os.replace`+`fsync` atomic write with asserted single-match anchors. Brace/paren
  balance and `tsc` re-verified to 0. Backups at `.backups/bug045-2026-07-12/`.
  **This is now a reliable pattern, not bad luck — treat the edit tool as unsafe for
  these files and prefer atomic-write patching.**

### BUG-033 re-probe (2026-07-12) — still unreachable, still blocked
`web_fetch https://labtodate.com/` returned an empty body again (no served document).
`list_connected_browsers` → `[]` — no Chrome extension connected, and an unattended
scheduled run cannot obtain an interactive grant. No browser audit possible; **no
promotion** of any browser-unverified item (BUG-001/002/004/011/012/014/019/031/034-045
stay FIXED-code / browser-unverified). BUG-033 remains **OPEN / BLOCKED** (keystone).

### Blocked (unchanged — needs from user)
- BUG-013 (Stripe) — manual-payment is the official posture → not a launch blocker. BLOCKED.
- BUG-005 (email-verification rollout) — deliverability + backfill decision. BLOCKED.
- BUG-020 (notification inbox config + Resend domain verify) — owner edits in `/admin/settings`. BLOCKED.
- BUG-033 (site reachability + connected Chrome) — keystone. BLOCKED on user/infra.
- Recurring: `.git/index.lock` (0 bytes, 2026-06-13) still present; sandbox cannot delete it. **Needs from user:** delete `.git\index.lock` and find what keeps recreating it.
