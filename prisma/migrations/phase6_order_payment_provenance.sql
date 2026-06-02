-- Phase 6: payment method + billing address + buyer location on Order.
-- Filled at checkout (IP/country) and by the Stripe webhook (payment method).
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "billingAddress"      JSONB,
  ADD COLUMN IF NOT EXISTS "paymentMethodBrand"  TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethodLast4"  TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethodWallet" TEXT,
  ADD COLUMN IF NOT EXISTS "buyerIp"             TEXT,
  ADD COLUMN IF NOT EXISTS "buyerCountry"        TEXT;
