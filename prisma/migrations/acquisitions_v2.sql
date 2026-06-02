-- Acquisitions v2: post-accept lifecycle, price negotiation, throttled email.

-- SellSubmission: post-accept stage + agreed price + bank/shipping/receive/complete fields
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "acquisitionStage"  TEXT;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "agreedPriceCents"  INTEGER;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "agreedCurrency"    TEXT;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "sellerBankDetails" JSONB;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "sellerShippingCarrier"  TEXT;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "sellerShippingTracking" TEXT;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "sellerShippedAt"   TIMESTAMP(3);
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "receivedAt"        TIMESTAMP(3);
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "receivedById"      TEXT;
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "completedAt"       TIMESTAMP(3);
ALTER TABLE "SellSubmission" ADD COLUMN IF NOT EXISTS "paymentReceiptUrl" TEXT;
CREATE INDEX IF NOT EXISTS "SellSubmission_acquisitionStage_idx" ON "SellSubmission" ("acquisitionStage");

-- SellMessage: typed messages (TEXT default, PRICE_PROPOSAL with priceCents, etc.)
ALTER TABLE "SellMessage" ADD COLUMN IF NOT EXISTS "kind"        TEXT NOT NULL DEFAULT 'TEXT';
ALTER TABLE "SellMessage" ADD COLUMN IF NOT EXISTS "priceCents"  INTEGER;
ALTER TABLE "SellMessage" ADD COLUMN IF NOT EXISTS "currency"    TEXT;

-- User: saved seller bank-payout details
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "sellerBankDetails" JSONB;
