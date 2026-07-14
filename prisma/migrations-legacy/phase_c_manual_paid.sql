-- Phase C: manual-paid flow (bank transfer / invoice / receipt upload).
ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paidByAdminId"       TEXT,
  ADD COLUMN IF NOT EXISTS "paymentMethodManual" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProofUrl"     TEXT,
  ADD COLUMN IF NOT EXISTS "paymentNote"         TEXT;
