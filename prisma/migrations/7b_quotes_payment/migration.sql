-- 7b_quotes_payment (team: quotes, offers & payment page)
-- Supplier proposals awaiting lab2date review (A30), lost reasons, buyer credit
-- terms (B07 minimal: approval + limit + term), and a de-duplication log for
-- automatic reminders / auto-cancel notices (A25). Additive only.

-- AlterTable
ALTER TABLE "SourcingRequest" ADD COLUMN     "sellerProposalStatus" TEXT,
ADD COLUMN     "sellerProposalCents" INTEGER,
ADD COLUMN     "sellerProposalCurrency" TEXT,
ADD COLUMN     "sellerProposalNote" TEXT,
ADD COLUMN     "sellerProposalTerms" JSONB,
ADD COLUMN     "sellerProposalAt" TIMESTAMP(3),
ADD COLUMN     "sellerProposalById" TEXT,
ADD COLUMN     "sellerProposalReviewNote" TEXT,
ADD COLUMN     "offerSupplierCostCents" INTEGER,
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "lostNote" TEXT;

-- AlterTable
ALTER TABLE "BillingProfile" ADD COLUMN     "creditApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "creditLimitCents" INTEGER,
ADD COLUMN     "creditTermDays" INTEGER,
ADD COLUMN     "creditApprovedAt" TIMESTAMP(3),
ADD COLUMN     "creditApprovedById" TEXT,
ADD COLUMN     "creditNote" TEXT;

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailOk" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReminderLog_sentAt_idx" ON "ReminderLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_subjectType_subjectId_kind_step_key" ON "ReminderLog"("subjectType", "subjectId", "kind", "step");

