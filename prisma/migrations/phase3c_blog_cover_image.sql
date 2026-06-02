-- Phase 3c: real cover photos for blog posts (uploaded image URL).
-- Illustration stays as a fallback when coverImage is null.

ALTER TABLE "BlogPost"
  ADD COLUMN IF NOT EXISTS "coverImage" TEXT;
