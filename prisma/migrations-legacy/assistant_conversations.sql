CREATE TABLE IF NOT EXISTS "AssistantConversation" (
  id              TEXT PRIMARY KEY,
  "userId"        TEXT,
  "guestToken"    TEXT,
  "guestName"     TEXT,
  "guestEmail"    TEXT,
  status          TEXT NOT NULL DEFAULT 'AI',
  subject         TEXT,
  "assignedToId"  TEXT,
  "closedAt"      TIMESTAMP(3),
  "closedById"    TEXT,
  rating          INTEGER,
  "ratingNote"    TEXT,
  "ratedAt"       TIMESTAMP(3),
  "archivedAt"    TIMESTAMP(3),
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "AssistantConversation_userId_idx" ON "AssistantConversation" ("userId");
CREATE INDEX IF NOT EXISTS "AssistantConversation_guestToken_idx" ON "AssistantConversation" ("guestToken");
CREATE INDEX IF NOT EXISTS "AssistantConversation_status_lastMessageAt_idx" ON "AssistantConversation" (status, "lastMessageAt");

CREATE TABLE IF NOT EXISTS "AssistantMessage" (
  id               TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  role             TEXT NOT NULL,
  "authorId"       TEXT,
  body             TEXT NOT NULL,
  attachments      TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssistantMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "AssistantMessage_conversationId_idx" ON "AssistantMessage" ("conversationId");
