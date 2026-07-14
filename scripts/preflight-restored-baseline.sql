-- preflight-restored-baseline.sql
-- ---------------------------------------------------------------------------
-- Fingerprints a database restored from .backups/lab2date-prod.sql.gz and RAISES
-- if it does not match the 0_baseline dump-state. Run this BEFORE
-- `prisma migrate resolve --applied 0_baseline` so an incompatible DB is NEVER
-- marked as baselined. Read-only (no writes); any mismatch aborts (nonzero exit
-- under `psql -v ON_ERROR_STOP=1`).
--
--   docker compose exec -T db psql -U lab2date -d lab2date -v ON_ERROR_STOP=1 \
--     < scripts/preflight-restored-baseline.sql
--
-- All catalog checks are scoped to the `public` schema by relation/constraint
-- OID + namespace (never by bare relname/conname), so objects in another schema
-- cannot cause a false pass or a multiplicative count.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  n bigint;
  missing text := '';
  name text;
  pub oid := 'public'::regnamespace;
  expect_partial_nonunique text[] := ARRAY[
    'Order_archivedAt_idx','Order_paymentVerificationStatus_idx',
    'SourcingRequest_archivedAt_idx','SourcingRequest_dueAt_idx','SourcingRequest_lastReplyAt_idx',
    'SourcingRequest_validUntilAt_idx','SupportTicket_archivedAt_idx','SupportTicket_assignedToId_idx',
    'SupportTicket_dueAt_idx','SupportTicket_lastReplyAt_idx','SupportTicket_orderId_idx',
    'SupportTicket_sourcingRequestId_idx'];
  expect_partial_unique text[] := ARRAY[
    'Product_sourceUrl_key','SourcingRequest_proformaNumber_key',
    'SourcingRequest_accessToken_key','SupportTicket_accessToken_key'];
BEGIN
  -- (1) core tables present (public-qualified)
  FOREACH name IN ARRAY ARRAY['Product','Order','OrderItem','SupportTicket','SourcingRequest',
                              'WebhookConfig','user','AssistantConversation','AssistantMessage',
                              'SellMessage','SellSubmission'] LOOP
    IF to_regclass(format('public.%I', name)) IS NULL THEN missing := missing || name || ' '; END IF;
  END LOOP;
  IF length(missing) > 0 THEN RAISE EXCEPTION 'PREFLIGHT: missing core tables: %', missing; END IF;

  -- (2) partial-index fingerprint: exactly 12 non-unique + 4 unique in public, by name.
  --     Scoped by index-relation OID + namespace; partial detected via pg_get_indexdef.
  SELECT count(*) INTO n FROM pg_index i
    JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relnamespace = pub
    WHERE NOT i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '% WHERE %';
  IF n <> 12 THEN RAISE EXCEPTION 'PREFLIGHT: expected 12 partial non-unique indexes in public, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_index i
    JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relnamespace = pub
    WHERE i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '% WHERE %';
  IF n <> 4 THEN RAISE EXCEPTION 'PREFLIGHT: expected 4 partial unique indexes in public, found %', n; END IF;

  FOREACH name IN ARRAY expect_partial_nonunique LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relnamespace = pub
      WHERE ci.relname = name AND NOT i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '% WHERE %')
      THEN missing := missing || name || ' '; END IF;
  END LOOP;
  FOREACH name IN ARRAY expect_partial_unique LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relnamespace = pub
      WHERE ci.relname = name AND i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '% WHERE %')
      THEN missing := missing || name || ' '; END IF;
  END LOOP;
  IF length(missing) > 0 THEN RAISE EXCEPTION 'PREFLIGHT: expected partial index(es) missing/not-partial in public: %', missing; END IF;

  -- (3) OrderItem.productId FK must be ON DELETE RESTRICT (confdeltype 'r'), in public
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = pub
    AND conname = 'OrderItem_productId_fkey' AND contype = 'f' AND confdeltype = 'r') THEN
    RAISE EXCEPTION 'PREFLIGHT: OrderItem_productId_fkey missing or not ON DELETE RESTRICT'; END IF;

  -- (4) 3 FKs must exist ON UPDATE NO ACTION (confupdtype 'a') — dump state, in public
  FOREACH name IN ARRAY ARRAY['AssistantConversation_userId_fkey',
    'AssistantMessage_conversationId_fkey','SellMessage_submissionId_fkey'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = pub
      AND conname = name AND contype = 'f' AND confupdtype = 'a') THEN missing := missing || name || ' '; END IF;
  END LOOP;
  IF length(missing) > 0 THEN RAISE EXCEPTION 'PREFLIGHT: FK(s) not in expected ON UPDATE NO ACTION dump state: %', missing; END IF;

  -- (5) SupportTicket.assignedToId FK must be ABSENT in public (1_reconcile adds it)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = pub
    AND conname = 'SupportTicket_assignedToId_fkey' AND contype = 'f') THEN
    RAISE EXCEPTION 'PREFLIGHT: SupportTicket_assignedToId_fkey already present — not dump state'; END IF;

  -- (6) WebhookConfig: isActive index present (public), updatedAt has a DEFAULT
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid AND ci.relnamespace = pub
    WHERE ci.relname = 'WebhookConfig_isActive_idx') THEN
    RAISE EXCEPTION 'PREFLIGHT: WebhookConfig_isActive_idx missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'WebhookConfig' AND column_name = 'updatedAt' AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'PREFLIGHT: WebhookConfig.updatedAt has no DEFAULT'; END IF;

  -- (7) duplicate guards — the 4 unique conversions must be safe (0 dup groups)
  SELECT count(*) INTO n FROM (SELECT "sourceUrl" FROM "Product" WHERE "sourceUrl" IS NOT NULL GROUP BY "sourceUrl" HAVING count(*)>1) x;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: Product.sourceUrl has % duplicate group(s)', n; END IF;
  SELECT count(*) INTO n FROM (SELECT "proformaNumber" FROM "SourcingRequest" WHERE "proformaNumber" IS NOT NULL GROUP BY "proformaNumber" HAVING count(*)>1) x;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: SourcingRequest.proformaNumber has % duplicate group(s)', n; END IF;
  SELECT count(*) INTO n FROM (SELECT "accessToken" FROM "SourcingRequest" WHERE "accessToken" IS NOT NULL GROUP BY "accessToken" HAVING count(*)>1) x;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: SourcingRequest.accessToken has % duplicate group(s)', n; END IF;
  SELECT count(*) INTO n FROM (SELECT "accessToken" FROM "SupportTicket" WHERE "accessToken" IS NOT NULL GROUP BY "accessToken" HAVING count(*)>1) x;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: SupportTicket.accessToken has % duplicate group(s)', n; END IF;

  -- (8) orphan guards — FK edges 1_reconcile creates/normalizes must be clean
  SELECT count(*) INTO n FROM "SupportTicket" t LEFT JOIN "user" u ON t."assignedToId"=u."id" WHERE t."assignedToId" IS NOT NULL AND u."id" IS NULL;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: SupportTicket.assignedToId has % orphan(s)', n; END IF;
  SELECT count(*) INTO n FROM "AssistantConversation" c LEFT JOIN "user" u ON c."userId"=u."id" WHERE c."userId" IS NOT NULL AND u."id" IS NULL;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: AssistantConversation.userId has % orphan(s)', n; END IF;
  SELECT count(*) INTO n FROM "AssistantMessage" m LEFT JOIN "AssistantConversation" c ON m."conversationId"=c."id" WHERE m."conversationId" IS NOT NULL AND c."id" IS NULL;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: AssistantMessage.conversationId has % orphan(s)', n; END IF;
  SELECT count(*) INTO n FROM "SellMessage" s LEFT JOIN "SellSubmission" ss ON s."submissionId"=ss."id" WHERE s."submissionId" IS NOT NULL AND ss."id" IS NULL;
  IF n>0 THEN RAISE EXCEPTION 'PREFLIGHT: SellMessage.submissionId has % orphan(s)', n; END IF;

  RAISE NOTICE 'PREFLIGHT OK: restored DB matches 0_baseline dump-state — safe to resolve --applied 0_baseline';
END
$preflight$;
