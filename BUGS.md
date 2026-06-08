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

### NEW BUG-015 · P1 · OPEN · Reliability/Perf · RSC prefetch returns 503 site-wide
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

### NEW BUG-016 · P2 · OPEN · Content · Blog cover images 403
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

### NEW BUG-019 · P2 · OPEN · UX/Business-logic · Admin "Archive" gives no buyer-facing closure
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
