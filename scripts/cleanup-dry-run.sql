-- ============================================================================
-- lab2date — Legacy Reconciliation Dry-Run
-- ============================================================================
-- All queries below are SELECT-only. They produce row counts and sample data
-- so the operator can decide which targets to mutate next.
--
-- USAGE (psql on the production host, or via prisma db push session):
--   psql "$DATABASE_URL" -f scripts/cleanup-dry-run.sql > cleanup-counts.txt
--
-- Then send the resulting cleanup-counts.txt back to the orchestrator. NO
-- mutation runs until each target is explicitly approved.
--
-- Real Prisma table names use unquoted lowercase (default Postgres folding)
-- EXCEPT models that set @@map (User → "user", Session → "session",
-- Account → "account", Verification → "verification"). All other models use
-- their Prisma name as-is — Postgres folds them to lowercase. We quote
-- every identifier for safety.
--
-- ============================================================================
\echo '=== lab2date dry-run · counts only · no mutation ==='
\echo ''

-- ----------------------------------------------------------------------------
-- 1. Address-less SHIPPED/DELIVERED orders
-- ----------------------------------------------------------------------------
-- These rows are the smoking gun from the RB audit (Q6BEQM, 5LX2KB, TATSIL).
-- The fix already deployed (BUG-009) blocks NEW occurrences server-side, but
-- the existing rows need either a backfill (admin enters the address) or a
-- soft archive. Either way, surface the list.
\echo '--- 1. Address-less SHIPPED/DELIVERED orders ---'
SELECT
  "orderNumber",
  "status",
  "createdAt"::date AS created_on,
  CASE WHEN "shippingAddress" IS NULL THEN 'NULL'
       ELSE 'PRESENT-BUT-INVALID'
  END AS address_state
FROM "Order"
WHERE "status" IN ('SHIPPED','DELIVERED')
  AND (
    "shippingAddress" IS NULL
    OR jsonb_typeof("shippingAddress") <> 'object'
    OR COALESCE("shippingAddress"->>'name','') = ''
    OR COALESCE("shippingAddress"->'address'->>'line1','') = ''
    OR COALESCE("shippingAddress"->'address'->>'city','') = ''
    OR COALESCE("shippingAddress"->'address'->>'postal_code','') = ''
    OR COALESCE("shippingAddress"->'address'->>'country','') = ''
  )
ORDER BY "createdAt" ASC;

\echo ''
\echo '--- 1b. Count of address-less SHIPPED/DELIVERED orders ---'
SELECT COUNT(*) AS address_less_shipped_count
FROM "Order"
WHERE "status" IN ('SHIPPED','DELIVERED')
  AND (
    "shippingAddress" IS NULL
    OR jsonb_typeof("shippingAddress") <> 'object'
    OR COALESCE("shippingAddress"->>'name','') = ''
    OR COALESCE("shippingAddress"->'address'->>'line1','') = ''
    OR COALESCE("shippingAddress"->'address'->>'city','') = ''
    OR COALESCE("shippingAddress"->'address'->>'postal_code','') = ''
    OR COALESCE("shippingAddress"->'address'->>'country','') = ''
  );

-- ----------------------------------------------------------------------------
-- 2. Duplicate fulfillment audit rows (×17 bug evidence)
-- ----------------------------------------------------------------------------
-- AuditLog stores no orderId column directly; the target column holds the
-- order id. Group by target+action+meta — if the same triplet appears > 1
-- in a short window, that's the dup-write footprint.
\echo ''
\echo '--- 2. Orders with >1 order.fulfillment audit row (idempotency bug) ---'
SELECT
  "target" AS order_id,
  "action",
  COUNT(*) AS dup_count,
  MIN("createdAt") AS first_seen,
  MAX("createdAt") AS last_seen
FROM "AuditLog"
WHERE "action" = 'order.fulfillment'
GROUP BY "target", "action"
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC
LIMIT 50;

\echo ''
\echo '--- 2b. Total duplicate audit rows for fulfillment ---'
SELECT
  SUM(dup_count - 1) AS extra_rows_to_collapse
FROM (
  SELECT COUNT(*) AS dup_count
  FROM "AuditLog"
  WHERE "action" = 'order.fulfillment'
  GROUP BY "target", "action"
  HAVING COUNT(*) > 1
) g;

-- ----------------------------------------------------------------------------
-- 3. K invariant: proof present + unverified + already PAID (expect 0)
-- ----------------------------------------------------------------------------
-- If this ever returns a row, the manual-verify gate has a leak somewhere.
\echo ''
\echo '--- 3. AWAITING_VERIFICATION leak check (paymentProof present, not verified, status=PAID) ---'
SELECT
  "orderNumber",
  "status",
  "paymentVerificationStatus",
  "paymentProofUrl" IS NOT NULL AS has_proof,
  "paymentVerifiedAt"
FROM "Order"
WHERE "paymentProofUrl" IS NOT NULL
  AND "paymentVerifiedAt" IS NULL
  AND "status" = 'PAID';

-- ----------------------------------------------------------------------------
-- 4. Price snapshot mismatch (Order.totalCents != sum of line items)
-- ----------------------------------------------------------------------------
-- OVTULH is the known offender (5k vs 4k). Surface every order where the
-- invariant total = subtotal + shipping + tax does NOT hold, AND where the
-- line items sum doesn't reconcile to subtotal.
\echo ''
\echo '--- 4a. Orders where totalCents != subtotal + shipping + tax (P0 invariant) ---'
SELECT
  "orderNumber",
  "subtotalCents",
  "shippingCents",
  "taxCents",
  "totalCents",
  ("subtotalCents" + "shippingCents" + "taxCents") AS computed_total,
  "totalCents" - ("subtotalCents" + "shippingCents" + "taxCents") AS delta_cents
FROM "Order"
WHERE "totalCents" <> ("subtotalCents" + "shippingCents" + "taxCents")
ORDER BY ABS("totalCents" - ("subtotalCents" + "shippingCents" + "taxCents")) DESC
LIMIT 50;

\echo ''
\echo '--- 4b. Orders where subtotal != SUM(line item snapshot * qty) ---'
SELECT
  o."orderNumber",
  o."subtotalCents",
  COALESCE(SUM(oi."priceCentsSnapshot" * oi."quantity"), 0) AS line_sum_cents,
  o."subtotalCents" - COALESCE(SUM(oi."priceCentsSnapshot" * oi."quantity"), 0) AS delta_cents
FROM "Order" o
LEFT JOIN "OrderItem" oi ON oi."orderId" = o."id"
GROUP BY o."id", o."orderNumber", o."subtotalCents"
HAVING o."subtotalCents" <> COALESCE(SUM(oi."priceCentsSnapshot" * oi."quantity"), 0)
ORDER BY ABS(o."subtotalCents" - COALESCE(SUM(oi."priceCentsSnapshot" * oi."quantity"), 0)) DESC
LIMIT 50;

-- ----------------------------------------------------------------------------
-- 5. Orphan line items (product hard-deleted, OrderItem.productId still set)
-- ----------------------------------------------------------------------------
-- Per audit: "Analytics top product = (deleted product) 2 units · €15,250".
-- BUG-004 already prevents future hard-deletes on products with order
-- history. Existing orphans need name backfill so reports don't render
-- "(deleted product)".
\echo ''
\echo '--- 5a. Orphan OrderItem rows (product missing) ---'
SELECT
  oi."id" AS order_item_id,
  oi."orderId",
  oi."productId" AS orphan_product_id,
  oi."titleSnapshot",
  oi."priceCentsSnapshot",
  oi."quantity"
FROM "OrderItem" oi
LEFT JOIN "Product" p ON p."id" = oi."productId"
WHERE oi."productId" IS NOT NULL AND p."id" IS NULL
LIMIT 100;

\echo ''
\echo '--- 5b. Count of orphan OrderItems ---'
SELECT COUNT(*) AS orphan_order_item_count
FROM "OrderItem" oi
LEFT JOIN "Product" p ON p."id" = oi."productId"
WHERE oi."productId" IS NOT NULL AND p."id" IS NULL;

-- ----------------------------------------------------------------------------
-- 6. Missing payment_method on verified manual orders (BUG-014)
-- ----------------------------------------------------------------------------
\echo ''
\echo '--- 6. PAID orders with no payment_method (manual or brand) ---'
SELECT
  "orderNumber",
  "status",
  "paymentVerifiedAt",
  "paymentMethodManual",
  "paymentMethodBrand"
FROM "Order"
WHERE "status" = 'PAID'
  AND (
    ("paymentMethodManual" IS NULL OR "paymentMethodManual" = '')
    AND ("paymentMethodBrand" IS NULL OR "paymentMethodBrand" = '')
  );

-- ----------------------------------------------------------------------------
-- 7. SourcingRequest state contradictions
-- ----------------------------------------------------------------------------
-- RB audit: "RFQ-N5MDJA CLOSED yet 'awaiting quote'". A CLOSED quote with
-- no proforma and no staff reply is suspicious — likely orphan or operator
-- error. Surface them for review.
\echo ''
\echo '--- 7. CLOSED quotes with no proforma and no staff reply ---'
SELECT
  s."id",
  s."buyerEmail",
  s."status",
  s."proformaNumber",
  s."createdAt"::date AS created_on,
  s."updatedAt"::date AS updated_on,
  (SELECT COUNT(*) FROM "QuoteMessage" qm
   WHERE qm."sourcingRequestId" = s."id" AND qm."fromStaff" = TRUE) AS staff_replies
FROM "SourcingRequest" s
WHERE s."status" = 'CLOSED'
  AND s."proformaNumber" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "QuoteMessage" qm
    WHERE qm."sourcingRequestId" = s."id" AND qm."fromStaff" = TRUE
  )
LIMIT 100;

-- ----------------------------------------------------------------------------
-- 8. High-value sanity (per RB: €500k AM2MPP refunded)
-- ----------------------------------------------------------------------------
\echo ''
\echo '--- 8. Orders >= 100 000 EUR-equivalent (10 000 000 cents) ---'
SELECT
  "orderNumber",
  "status",
  "currency",
  "totalCents",
  "createdAt"::date AS created_on,
  "paidAt"::date AS paid_on
FROM "Order"
WHERE "totalCents" >= 10000000
ORDER BY "totalCents" DESC;

-- ----------------------------------------------------------------------------
-- 9. Junk tracking & address signals
-- ----------------------------------------------------------------------------
-- Heuristics for obvious test data: very-short or repeated-char tracking
-- numbers; addresses where line1 is all digits or under 4 chars.
\echo ''
\echo '--- 9a. Suspicious tracking numbers (length < 5, or only same char) ---'
SELECT
  "orderNumber",
  "status",
  "trackingCarrier",
  "trackingNumber"
FROM "Order"
WHERE "trackingNumber" IS NOT NULL
  AND (
    LENGTH("trackingNumber") < 5
    OR "trackingNumber" ~ '^(.)\1+$'
  );

\echo ''
\echo '--- 9b. Suspicious shippingAddress line1 (too short / digits-only) ---'
SELECT
  "orderNumber",
  "status",
  "shippingAddress"->>'name' AS recipient,
  "shippingAddress"->'address'->>'line1' AS line1,
  "shippingAddress"->'address'->>'city' AS city
FROM "Order"
WHERE "shippingAddress" IS NOT NULL
  AND jsonb_typeof("shippingAddress") = 'object'
  AND (
    LENGTH(COALESCE("shippingAddress"->'address'->>'line1', '')) < 4
    OR ("shippingAddress"->'address'->>'line1') ~ '^[0-9 ]+$'
  )
LIMIT 100;

-- ----------------------------------------------------------------------------
-- 10. @lab2date-e2e.local / @lab2date.test / @lab2date.invalid accounts
-- ----------------------------------------------------------------------------
\echo ''
\echo '--- 10. Likely test accounts (by email domain) ---'
SELECT
  "id",
  "email",
  "role",
  "createdAt"::date AS created_on,
  "suspendedAt" IS NOT NULL AS suspended
FROM "user"
WHERE "email" ~* '@(lab2date-e2e\.local|lab2date\.test|lab2date\.invalid)$'
ORDER BY "createdAt" ASC;

-- ----------------------------------------------------------------------------
-- 11. Self-transfer quote audit rows (from=to)
-- ----------------------------------------------------------------------------
\echo ''
\echo '--- 11. quote.transfer rows where from = to (self-transfer no-ops) ---'
SELECT
  "id",
  "actorEmail",
  "action",
  "target",
  "meta",
  "createdAt"
FROM "AuditLog"
WHERE "action" = 'quote.transfer'
  AND "meta" ~ 'from=([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+) to=\1'
LIMIT 100;

-- ----------------------------------------------------------------------------
-- 12. Final summary table
-- ----------------------------------------------------------------------------
\echo ''
\echo '=== SUMMARY (single row, all dry-run counts) ==='
SELECT
  (SELECT COUNT(*) FROM "Order"
   WHERE "status" IN ('SHIPPED','DELIVERED')
     AND ("shippingAddress" IS NULL
       OR COALESCE("shippingAddress"->'address'->>'line1','') = '')
  ) AS address_less_shipped,

  (SELECT COALESCE(SUM(dup_count - 1), 0) FROM (
    SELECT COUNT(*) AS dup_count
    FROM "AuditLog" WHERE "action" = 'order.fulfillment'
    GROUP BY "target", "action" HAVING COUNT(*) > 1
   ) g
  ) AS dup_fulfillment_audit_rows,

  (SELECT COUNT(*) FROM "Order"
   WHERE "paymentProofUrl" IS NOT NULL
     AND "paymentVerifiedAt" IS NULL AND "status" = 'PAID'
  ) AS verify_gate_leaks,

  (SELECT COUNT(*) FROM "Order"
   WHERE "totalCents" <> ("subtotalCents" + "shippingCents" + "taxCents")
  ) AS total_invariant_breaks,

  (SELECT COUNT(*) FROM "OrderItem" oi
   LEFT JOIN "Product" p ON p."id" = oi."productId"
   WHERE oi."productId" IS NOT NULL AND p."id" IS NULL
  ) AS orphan_order_items,

  (SELECT COUNT(*) FROM "Order"
   WHERE "status" = 'PAID'
     AND ("paymentMethodManual" IS NULL OR "paymentMethodManual" = '')
     AND ("paymentMethodBrand" IS NULL OR "paymentMethodBrand" = '')
  ) AS paid_no_method,

  (SELECT COUNT(*) FROM "user"
   WHERE "email" ~* '@(lab2date-e2e\.local|lab2date\.test|lab2date\.invalid)$'
  ) AS test_accounts,

  (SELECT COUNT(*) FROM "Order"
   WHERE "totalCents" >= 10000000
  ) AS high_value_orders;

\echo ''
\echo '=== Done. Send cleanup-counts.txt back to the orchestrator. ==='
