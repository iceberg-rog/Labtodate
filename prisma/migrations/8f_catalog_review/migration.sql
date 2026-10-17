-- 8f_catalog_review (team: stage-2 catalog fixes)
--  * Supplier price changes beyond the review thresholds (Settings → Import &
--    suppliers) wait on the product for an admin instead of going live:
--    pendingPrice* = the new source price + why; priceOnHold = the listing
--    cannot be bought and shows no public price meanwhile.
--  * displayPriceCents (migration 7a) is NULL while priceOnHold is set: the
--    product trigger is replaced to read the new column (and to fire on it).
--  * Data: imported listings (importer accounts seed_user_seller_*) no longer
--    claim the generic "balance" drawing as their picture — every import got
--    it whatever the item was (a motor shown as an analytical balance).
-- Additive only; the data step is idempotent.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "pendingPriceAt" TIMESTAMP(3),
ADD COLUMN     "pendingPriceCents" INTEGER,
ADD COLUMN     "pendingPriceCurrency" TEXT,
ADD COLUMN     "pendingPriceNote" TEXT,
ADD COLUMN     "priceOnHold" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Product_pendingPriceAt_idx" ON "Product"("pendingPriceAt");

-- Public sell price: NULL while the price is on hold for review. Otherwise the
-- 7a rule (l2d_sell_price — the SQL twin of resolveSellPrice()).
CREATE OR REPLACE FUNCTION l2d_product_display_price() RETURNS trigger AS $fn$
DECLARE c_mode text; c_markup integer;
BEGIN
  IF NEW."priceOnHold" THEN
    NEW."displayPriceCents" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."companyId" IS NOT NULL THEN
    SELECT "pricingMode"::text, "pricingMarkupBp" INTO c_mode, c_markup FROM "Company" WHERE "id" = NEW."companyId";
  END IF;
  NEW."displayPriceCents" := l2d_sell_price(NEW."priceCents", COALESCE(c_mode, 'PASS_THROUGH'), c_markup);
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Product_display_price" ON "Product";
CREATE TRIGGER "Product_display_price" BEFORE INSERT OR UPDATE OF "priceCents", "companyId", "displayPriceCents", "priceOnHold" ON "Product"
  FOR EACH ROW EXECUTE FUNCTION l2d_product_display_price();

CREATE OR REPLACE FUNCTION l2d_company_display_price() RETURNS trigger AS $fn$
BEGIN
  IF NEW."pricingMode" IS DISTINCT FROM OLD."pricingMode" OR NEW."pricingMarkupBp" IS DISTINCT FROM OLD."pricingMarkupBp" THEN
    UPDATE "Product"
       SET "displayPriceCents" = CASE WHEN "priceOnHold" THEN NULL ELSE l2d_sell_price("priceCents", NEW."pricingMode"::text, NEW."pricingMarkupBp") END
     WHERE "companyId" = NEW."id";
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

-- Data: no generic drawing as the picture of an imported item.
UPDATE "Product" SET "illustration" = NULL
 WHERE "illustration" = 'balance' AND "sellerId" LIKE 'seed\_user\_seller\_%';
