-- Existing registration dates were never recorded; leave them NULL.
ALTER TABLE "users" ADD COLUMN "avatar_url" TEXT;
ALTER TABLE "users" ADD COLUMN "created_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;
