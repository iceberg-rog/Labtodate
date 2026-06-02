# Changes manifest — 2026-05-29 (round 2)

**Apply these to your canonical git repo before deploying.** Production
(`labtodate.com`) is unchanged until you deploy. This round resumes after the
round-1 truncation incident (now resolved — see `INCIDENT-2026-05-29.md`).

All changes below pass `npx tsc --noEmit` (exit 0) on the full project.
None are browser-verified — Claude in Chrome permission for `labtodate.com`
is still not granted, so nothing this round is marked VERIFIED.

## Files changed

### src/lib/orders/actions.ts  (BUG-003)
- Single-product `startCheckoutWithAddress`: the last hardcoded `€` in the
  `notifyAdmins` "New order …" text is gone. Total is now formatted with
  `Intl.NumberFormat('en-US', { style:'currency', currency: product.currency })`,
  with a `CUR 0.00` plain-text fallback. Matches the cart + webhook paths.
- **Note:** this file was truncated by the Edit tool mid-edit and recovered from
  the compiled bundle, then re-applied via shell. Verify line count = **442**
  and that the file ends with `redirect(checkout.url);` + closing `}`.

### src/app/api/cron/sla-sweep/route.ts  (BUG-007)
- New "Orphaned PENDING_PAYMENT order sweep" section before the summary return.
- Cancels stale unpaid orders and **releases reserved stock** (increments
  `product.quantity` per `OrderItem`, once).
- **Manual-payment-safe by design:**
  - TTL is generous and configurable: `ORPHAN_ORDER_TTL_MINUTES` (default
    `10080` = 7 days), so legitimate bank-transfer buyers are never cut off early.
  - Only matches orders with `stripeSessionId = null`, `paymentSubmittedAt = null`,
    `paymentVerificationStatus = null`, `sourcingRequestId = null`, `archivedAt = null`.
  - Race-safe: cancel is an atomic `updateMany` guarded by
    `status:'PENDING_PAYMENT', paymentSubmittedAt:null`; only `count === 1`
    releases stock. A buyer who submits proof between select and update wins.
  - Idempotent: CANCELED rows fall out of the WHERE on the next sweep.
- New response field: `orphanOrders: { canceled }`; folded into `swept` total.
- **New env (optional):** `ORPHAN_ORDER_TTL_MINUTES`. Unset → 7-day default.

### src/lib/auth.ts  (BUG-006)
- `minPasswordLength` raised 8 → 12. Affects only newly-set passwords
  (sign-up / reset). Existing users are not locked out.

## Verified-present-in-source (round-1 fixes, re-checked; no change this round)
- BUG-001 publishProduct gate · `src/app/app/seller/products/actions.ts`
- BUG-002 webhook idempotency + Intl currency · `src/app/api/stripe/webhook/route.ts`
- BUG-004 deleteProduct → ARCHIVE · `src/app/app/seller/products/actions.ts`
- BUG-008 cart notifyAdmins `'ORDER_NEW'` 4th arg · `src/lib/cart/actions.ts`
- BUG-011 cart address gate + `src/app/checkout/cart/page.tsx`

## Expected line counts after apply
```
src/lib/orders/actions.ts            : 442
src/app/api/cron/sla-sweep/route.ts  : 274
src/lib/auth.ts                      : 124
```

## Verify
```bash
npx tsc --noEmit          # must exit 0
npm run build             # full standalone build
```

## Still open / blocked
- **BUG-005 email verification — BLOCKED.** No `emailVerification.sendVerificationEmail`
  handler is configured and existing users are almost certainly `emailVerified:false`.
  Flipping `requireEmailVerification:true` now would block password sign-in for the
  whole existing user base and send no verification email. **Need from you:** confirm
  prod email delivery is reliable + decide whether to backfill existing accounts as
  verified (or rely on magic-link). Then I'll wire the sender and flip the flag.
- **BUG-013 Stripe — deferred (not a blocker).** Manual-payment is the official
  posture; architecture stays Stripe-ready.
- **BUG-014 payment.method "—"** on verified BANK_TRANSFER orders — queued; needs
  the report renderer located to fold `paymentMethodManual` into the display column.
- **Browser audit (B1–B17)** — needs `labtodate.com` added to the Chrome extension
  permission list. Everything this round stays code-level / UNVERIFIED until then.
- **Legacy cleanup SQL** — `scripts/cleanup-dry-run.sql` still pending a prod run;
  mutations need your sign-off.
