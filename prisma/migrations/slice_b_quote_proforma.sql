-- Slice B: persist proforma metadata on SourcingRequest so the document is
-- stable across reloads, expiries are enforceable, and the email matches
-- exactly what the buyer sees in their dashboard.
--
-- proformaNumber       — human/AR identifier (e.g. PRO-2026-3F8K2A)
-- proformaIssuedAt     — when sendProforma was first called
-- validUntilAt         — quote expiry; past this we render an "Expired" badge
-- paymentInstructionsSnapshot — the exact bank/IBAN/SWIFT/reference text the
--                        buyer was shown at proforma time (immutable history)
ALTER TABLE "SourcingRequest"
  ADD COLUMN IF NOT EXISTS "proformaNumber"             TEXT,
  ADD COLUMN IF NOT EXISTS "proformaIssuedAt"           TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "validUntilAt"               TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paymentInstructionsSnapshot" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "SourcingRequest_proformaNumber_key"
  ON "SourcingRequest" ("proformaNumber") WHERE "proformaNumber" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "SourcingRequest_validUntilAt_idx"
  ON "SourcingRequest" ("validUntilAt") WHERE "validUntilAt" IS NOT NULL;
