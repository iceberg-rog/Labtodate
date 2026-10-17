-- 7a_checkout_pricing (team: stage-2 checkout & pricing)
-- Checkout on the VAT engine, real shipping, country policy and one sell price:
--  * Order: buyer type, B2B declaration, PO number, invoice email, shipping VAT
--    rate, the pricing evidence the buyer accepted, "payable since" for the
--    unpaid-order sweep, and the list of open pre-payment holds.
--  * OrderHoldReason PAYMENT_REVIEW (money received ≠ order total / currency).
--  * Product.displayPriceCents: the public sell price, maintained by triggers
--    (mirrors src/lib/pricing/resolve.ts) — filters, sort and public prices
--    never see the supplier price of a hidden / quote-only listing (A08).
--  * Company.importPricesIncludeVat / importVatRateBp (A26).
--  * AddressChange: old → new history of every order address change (A12).
-- Additive only; the data steps at the end are idempotent.

-- AlterEnum
ALTER TYPE "OrderHoldReason" ADD VALUE 'PAYMENT_REVIEW';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "importPricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "importVatRateBp" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "b2bDeclarationAt" TIMESTAMP(3),
ADD COLUMN     "customerType" "CustomerType",
ADD COLUMN     "invoiceEmail" TEXT,
ADD COLUMN     "openHolds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "payableSince" TIMESTAMP(3),
ADD COLUMN     "poNumber" TEXT,
ADD COLUMN     "pricingSnapshot" JSONB,
ADD COLUMN     "shippingVatRateBp" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "displayPriceCents" INTEGER;

-- CreateTable
CREATE TABLE "AddressChange" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AddressChange_orderId_idx" ON "AddressChange"("orderId");

-- CreateIndex
CREATE INDEX "Product_status_displayPriceCents_idx" ON "Product"("status", "displayPriceCents");

-- AddForeignKey
ALTER TABLE "AddressChange" ADD CONSTRAINT "AddressChange_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Public sell price (A08). l2d_sell_price() is the SQL twin of
-- resolveSellPrice() (src/lib/pricing/resolve.ts, rounding NONE):
--   no / non-positive price            → NULL
--   shop FORCE_QUOTE or HIDE_PRICE     → NULL (quote only, price never public)
--   shop MARKUP_PERCENT (markup ≠ 0)   → round(price × (10000 + bp) / 10000), half up
--   anything ≤ 0 after the markup      → NULL
-- A DB test (scripts/test-business-core.db.ts) checks both agree.
CREATE OR REPLACE FUNCTION l2d_sell_price(p_price integer, p_mode text, p_markup integer) RETURNS integer AS $fn$
DECLARE v numeric;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN RETURN NULL; END IF;
  IF p_mode IN ('FORCE_QUOTE', 'HIDE_PRICE') THEN RETURN NULL; END IF;
  IF p_mode = 'MARKUP_PERCENT' AND COALESCE(p_markup, 0) <> 0 THEN
    v := ROUND(p_price::numeric * (10000 + p_markup) / 10000);
  ELSE
    v := p_price;
  END IF;
  IF v <= 0 THEN RETURN NULL; END IF;
  RETURN v::integer;
END
$fn$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION l2d_product_display_price() RETURNS trigger AS $fn$
DECLARE c_mode text; c_markup integer;
BEGIN
  IF NEW."companyId" IS NOT NULL THEN
    SELECT "pricingMode"::text, "pricingMarkupBp" INTO c_mode, c_markup FROM "Company" WHERE "id" = NEW."companyId";
  END IF;
  NEW."displayPriceCents" := l2d_sell_price(NEW."priceCents", COALESCE(c_mode, 'PASS_THROUGH'), c_markup);
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Product_display_price" BEFORE INSERT OR UPDATE OF "priceCents", "companyId", "displayPriceCents" ON "Product"
  FOR EACH ROW EXECUTE FUNCTION l2d_product_display_price();

CREATE OR REPLACE FUNCTION l2d_company_display_price() RETURNS trigger AS $fn$
BEGIN
  IF NEW."pricingMode" IS DISTINCT FROM OLD."pricingMode" OR NEW."pricingMarkupBp" IS DISTINCT FROM OLD."pricingMarkupBp" THEN
    UPDATE "Product" SET "displayPriceCents" = l2d_sell_price("priceCents", NEW."pricingMode"::text, NEW."pricingMarkupBp")
     WHERE "companyId" = NEW."id";
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER "Company_display_price" AFTER UPDATE OF "pricingMode", "pricingMarkupBp" ON "Company"
  FOR EACH ROW EXECUTE FUNCTION l2d_company_display_price();

-- Backfill every product once (the trigger recomputes on this write).
UPDATE "Product" SET "displayPriceCents" = NULL;

-- Unpaid checkout orders that exist today were payable from creation: the
-- unpaid-order sweep keeps counting from their creation time.
UPDATE "Order" SET "payableSince" = "createdAt"
 WHERE "payableSince" IS NULL AND "status" = 'PENDING_PAYMENT' AND "holdReason" IS NULL;
