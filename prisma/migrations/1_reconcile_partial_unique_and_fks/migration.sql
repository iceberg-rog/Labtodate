-- 1_reconcile_partial_unique_and_fks
-- ---------------------------------------------------------------------------
-- Evolves the dump-state 0_baseline to match prisma/schema.prisma. Applied by
-- `prisma migrate deploy` on BOTH paths:
--   * fresh DB      — after 0_baseline (converts the just-created partial-unique
--                     indexes to full; guards see an empty DB → trivially pass)
--   * restored dump — after `migrate resolve --applied 0_baseline`
--
-- Reconciles the drift measured between the production dump and schema.prisma:
--   (A) 4 partial UNIQUE indexes      -> canonical full UNIQUE indexes
--   (B) 3 FKs onUpdate NO ACTION      -> CASCADE (identical on immutable cuid PKs)
--   (C) 1 missing FK                  -> SupportTicket.assignedToId (SET NULL)
--
-- Atomicity/rollback: Prisma does NOT wrap PostgreSQL migrations in a
-- transaction by default, so this migration opts in explicitly with the
-- BEGIN;/COMMIT; below. Any RAISE (or DDL error) aborts and rolls the whole
-- migration back, leaving the DB exactly as it was. Guards run FIRST, before any
-- mutation. Re-runnable by hand (all steps idempotent); Prisma records it once.
BEGIN;

-- (A0) GUARDS — duplicate values (unique) + orphan rows (FKs). Any violation
-- raises and rolls back the entire migration.
DO $guard$
DECLARE d bigint;
BEGIN
  SELECT count(*) INTO d FROM (SELECT "sourceUrl" FROM "Product"
    WHERE "sourceUrl" IS NOT NULL GROUP BY "sourceUrl" HAVING count(*) > 1) x;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: Product.sourceUrl has % duplicate group(s) — cannot build UNIQUE index', d; END IF;

  SELECT count(*) INTO d FROM (SELECT "proformaNumber" FROM "SourcingRequest"
    WHERE "proformaNumber" IS NOT NULL GROUP BY "proformaNumber" HAVING count(*) > 1) x;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: SourcingRequest.proformaNumber has % duplicate group(s)', d; END IF;

  SELECT count(*) INTO d FROM (SELECT "accessToken" FROM "SourcingRequest"
    WHERE "accessToken" IS NOT NULL GROUP BY "accessToken" HAVING count(*) > 1) x;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: SourcingRequest.accessToken has % duplicate group(s)', d; END IF;

  SELECT count(*) INTO d FROM (SELECT "accessToken" FROM "SupportTicket"
    WHERE "accessToken" IS NOT NULL GROUP BY "accessToken" HAVING count(*) > 1) x;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: SupportTicket.accessToken has % duplicate group(s)', d; END IF;

  SELECT count(*) INTO d FROM "SupportTicket" t LEFT JOIN "user" u ON t."assignedToId" = u."id"
    WHERE t."assignedToId" IS NOT NULL AND u."id" IS NULL;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: SupportTicket.assignedToId has % orphan row(s)', d; END IF;

  SELECT count(*) INTO d FROM "AssistantConversation" c LEFT JOIN "user" u ON c."userId" = u."id"
    WHERE c."userId" IS NOT NULL AND u."id" IS NULL;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: AssistantConversation.userId has % orphan row(s)', d; END IF;

  SELECT count(*) INTO d FROM "AssistantMessage" m LEFT JOIN "AssistantConversation" c ON m."conversationId" = c."id"
    WHERE m."conversationId" IS NOT NULL AND c."id" IS NULL;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: AssistantMessage.conversationId has % orphan row(s)', d; END IF;

  SELECT count(*) INTO d FROM "SellMessage" s LEFT JOIN "SellSubmission" ss ON s."submissionId" = ss."id"
    WHERE s."submissionId" IS NOT NULL AND ss."id" IS NULL;
  IF d > 0 THEN RAISE EXCEPTION 'GUARD: SellMessage.submissionId has % orphan row(s)', d; END IF;
END
$guard$;

-- (A) Normalize the 4 unique indexes to canonical FULL unique — UNCONDITIONALLY
-- drop whatever exists (partial, wrong, or already-full) and recreate the
-- canonical definition, so a missing/partial/malformed index cannot silently
-- survive. A full unique index on a nullable column still permits multiple NULLs.
DROP INDEX IF EXISTS "Product_sourceUrl_key";
CREATE UNIQUE INDEX "Product_sourceUrl_key" ON "Product"("sourceUrl");
DROP INDEX IF EXISTS "SourcingRequest_proformaNumber_key";
CREATE UNIQUE INDEX "SourcingRequest_proformaNumber_key" ON "SourcingRequest"("proformaNumber");
DROP INDEX IF EXISTS "SourcingRequest_accessToken_key";
CREATE UNIQUE INDEX "SourcingRequest_accessToken_key" ON "SourcingRequest"("accessToken");
DROP INDEX IF EXISTS "SupportTicket_accessToken_key";
CREATE UNIQUE INDEX "SupportTicket_accessToken_key" ON "SupportTicket"("accessToken");

-- (A1) POST-VALIDATION — assert each of the 4 is present, UNIQUE, and NOT
-- partial. Fails the migration (rollback) if normalization did not land.
DO $verify$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN
    SELECT n.name,
      (SELECT count(*) FROM pg_indexes pi JOIN pg_class c ON c.relname=pi.indexname
        JOIN pg_index ix ON ix.indexrelid=c.oid
        WHERE pi.schemaname='public' AND pi.indexname=n.name
          AND ix.indisunique AND pi.indexdef NOT ILIKE '% WHERE %') AS ok
    FROM (VALUES ('Product_sourceUrl_key'),('SourcingRequest_proformaNumber_key'),
                 ('SourcingRequest_accessToken_key'),('SupportTicket_accessToken_key')) n(name)
  LOOP
    IF r.ok <> 1 THEN bad := bad || r.name || ' '; END IF;
  END LOOP;
  IF length(bad) > 0 THEN
    RAISE EXCEPTION 'VALIDATION: canonical full-unique index missing/partial for: %', bad;
  END IF;
END
$verify$;

-- (B) Normalize onUpdate NO ACTION -> CASCADE on 3 FKs (behaviour-identical on
-- immutable cuid PKs; aligns with the Prisma-generated schema).
ALTER TABLE "AssistantConversation" DROP CONSTRAINT IF EXISTS "AssistantConversation_userId_fkey";
ALTER TABLE "AssistantConversation" ADD  CONSTRAINT "AssistantConversation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AssistantMessage" DROP CONSTRAINT IF EXISTS "AssistantMessage_conversationId_fkey";
ALTER TABLE "AssistantMessage" ADD  CONSTRAINT "AssistantMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellMessage" DROP CONSTRAINT IF EXISTS "SellMessage_submissionId_fkey";
ALTER TABLE "SellMessage" ADD  CONSTRAINT "SellMessage_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "SellSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (C) Add the FK the dump is missing entirely (SupportTicket.assignedToId).
ALTER TABLE "SupportTicket" DROP CONSTRAINT IF EXISTS "SupportTicket_assignedToId_fkey";
ALTER TABLE "SupportTicket" ADD  CONSTRAINT "SupportTicket_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
