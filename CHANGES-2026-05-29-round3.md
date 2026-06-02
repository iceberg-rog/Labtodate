# Changes manifest — 2026-05-29 (round 3)

Continuous-recovery batch. Production unchanged until you deploy. All changes
pass `npx tsc --noEmit` (exit 0, full project). Edits to large files were made
via the shell, not the Edit tool (the Edit tool truncates big `.ts` files —
see INCIDENT doc).

## Code changes

### src/app/admin/actions.ts  (BUG-014 defensive)
- `verifyPayment`: added `paymentMethodManual` to the order `select`, and on the
  PAID transition now writes `paymentMethodManual: order.paymentMethodManual ??
  'BANK_TRANSFER'`. A verified manual-posture order can therefore never render
  payment method "—". (Both display renderers were already correct; this closes
  the data-persistence edge.)
- Line count 2604 → 2609.

### src/app/admin/orders/[id]/page.tsx  (BUG-017 manual-posture copy)
- "Deposited into" no longer says "lab2date Stripe account (not configured)" for
  manual orders. When Stripe is unconfigured it now renders
  **"Manual settlement · bank transfer (no Stripe)"**; Stripe wording appears only
  when a real `STRIPE_SECRET_KEY` is present. Aligns admin copy with the
  no-fake-Stripe-wording rule.

## Browser-VERIFIED this batch (current-deployed build, TEST data, cleaned up)
- **Sourcing/quote intake** → admin → SLA → archive. Cleanup proof: Open 2→1,
  Archived 3→4.
- **Support ticket** intake → admin → **real-time notification (N3)** → staff
  reply (**S6** lastReply + status support→customer + buyer email) → archive.
  Cleanup proof: ARCHIVED badge + Restore button.
- **BUG-014** manifestation confirmed on `L2D-2026-TATSIL` (METHOD "—").

## Test-data hygiene
- All test records used the `QA-E2E` prefix and the owner's own email
  (iceberg.rig@gmail.com) — no third party contacted.
- Both test records (RFQ-5AF2X4, TKT-2026-7VVTQU) were archived (reversible).
  No hard deletes performed.

## Still blocked (logged, not stopping)
- **Deploy** — I cannot deploy (no deploy-host access; SSH forbidden as leaked).
  Round-2/3 code fixes stay UNVERIFIED until you deploy.
- **Role-negative tests (B7–B10, B17)** — need magic-link sign-in for a non-admin
  BUYER, a SELLER, and a limited-cap ADMIN test account.
- **Full TEST order/payment-proof/fulfillment E2E (B2–B6, B11–B13)** — doable as
  the admin/owner account on a TEST product; will run next batch unless you object
  (it creates revenue-affecting rows; I'll archive/cancel them with proof).
- **Legacy-data cleanup SQL** — needs your approval before any mutation.
- **BUG-015 (RSC 503) / BUG-016 (blog 403)** — infra fixes on the deploy host
  (nginx upstream / MinIO bucket policy); no app-code change.
