-- Add sourceUrl to Product for duplicate detection across imports.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Product_sourceUrl_key" ON "Product" ("sourceUrl") WHERE "sourceUrl" IS NOT NULL;
