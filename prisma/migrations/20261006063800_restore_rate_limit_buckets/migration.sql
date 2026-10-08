-- Authentication uses this table for shared rate limits. Model it in Prisma
-- so schema reconciliation preserves it. Keep existing buckets if present.
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
    "key" VARCHAR(300) NOT NULL,
    "count" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "rate_limit_buckets_count_check" CHECK ("count" > 0)
);

CREATE INDEX IF NOT EXISTS "rate_limit_buckets_reset_at_idx" ON "rate_limit_buckets"("reset_at");
