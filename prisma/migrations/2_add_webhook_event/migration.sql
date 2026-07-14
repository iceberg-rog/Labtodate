-- 2_add_webhook_event — durable exactly-once webhook/anomaly claim ledger.
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "orderId" TEXT,
    "outcome" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookEvent_orderId_idx" ON "WebhookEvent"("orderId");
