-- 5_security_platform: admin 2FA (better-auth twoFactor), step-up + idle
-- tracking on sessions, persistent rate limits / lockouts, staff invites,
-- queued announcements with consent + suppression, backup run log.

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "ip" TEXT;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "stepUpAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "marketingConsentAt" TIMESTAMP(3),
ADD COLUMN     "marketingConsentSource" TEXT,
ADD COLUMN     "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorEnabled" BOOLEAN DEFAULT false;

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "lockCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "staff_invite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "caps" TEXT[],
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedById" TEXT NOT NULL,
    "invitedByEmail" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_job" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "kind" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "emailRequested" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "inAppCount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "announcement_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_delivery" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "announcement_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppression" (
    "email" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppression_pkey" PRIMARY KEY ("email","scope")
);

-- CreateTable
CREATE TABLE "consent_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_run" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "host" TEXT,
    "target" TEXT,
    "archiveName" TEXT,
    "archiveBytes" BIGINT,
    "dbBytes" BIGINT,
    "mediaBytes" BIGINT,
    "mediaObjects" INTEGER,
    "sha256" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "log" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "two_factor_userId_idx" ON "two_factor"("userId");

-- CreateIndex
CREATE INDEX "two_factor_secret_idx" ON "two_factor"("secret");

-- CreateIndex
CREATE INDEX "rate_limit_bucket_resetAt_idx" ON "rate_limit_bucket"("resetAt");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invite_tokenHash_key" ON "staff_invite"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_invite_email_idx" ON "staff_invite"("email");

-- CreateIndex
CREATE INDEX "announcement_job_status_idx" ON "announcement_job"("status");

-- CreateIndex
CREATE INDEX "announcement_job_createdAt_idx" ON "announcement_job"("createdAt");

-- CreateIndex
CREATE INDEX "announcement_delivery_jobId_status_idx" ON "announcement_delivery"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_delivery_jobId_email_key" ON "announcement_delivery"("jobId", "email");

-- CreateIndex
CREATE INDEX "consent_event_email_idx" ON "consent_event"("email");

-- CreateIndex
CREATE INDEX "consent_event_userId_idx" ON "consent_event"("userId");

-- CreateIndex
CREATE INDEX "backup_run_startedAt_idx" ON "backup_run"("startedAt");

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_delivery" ADD CONSTRAINT "announcement_delivery_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "announcement_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Data: demotion used to leave adminCaps behind, so a later re-promotion
-- silently restored them. Non-admins hold no admin capabilities.
UPDATE "user" SET "adminCaps" = '{}' WHERE "role" <> 'ADMIN' AND cardinality("adminCaps") > 0;

-- Data: idle-timeout clock starts from the last known activity.
UPDATE "session" SET "lastActiveAt" = "updatedAt" WHERE "lastActiveAt" IS NULL;
