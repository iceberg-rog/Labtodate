-- Shop preview + AI-suggested-source columns. Applied 2026-05-24. Idempotent.

ALTER TABLE "Company"
  ADD COLUMN IF NOT EXISTS "suggestedByAi" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "aiRiskScore"   INTEGER,
  ADD COLUMN IF NOT EXISTS "aiRiskNotes"   TEXT,
  ADD COLUMN IF NOT EXISTS "aiAnalyzedAt"  TIMESTAMP(3);
