-- Phase 3: blog views + comments
-- Apply on remote DB before deploying the new container so the Prisma client
-- (regenerated during `docker compose build --no-cache web`) matches schema.

ALTER TABLE "BlogPost"
  ADD COLUMN IF NOT EXISTS "viewCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "BlogComment" (
  "id"          TEXT PRIMARY KEY,
  "postId"      TEXT NOT NULL,
  "authorName"  TEXT NOT NULL,
  "authorEmail" TEXT NOT NULL,
  "body"        TEXT NOT NULL,
  "approved"    BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlogComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BlogComment_postId_idx"   ON "BlogComment" ("postId");
CREATE INDEX IF NOT EXISTS "BlogComment_approved_idx" ON "BlogComment" ("approved");
