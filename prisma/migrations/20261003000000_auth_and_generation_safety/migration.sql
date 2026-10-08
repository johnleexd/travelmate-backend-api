CREATE TABLE "revoked_sessions" (
    "token_hash" VARCHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("token_hash"),
    CONSTRAINT "revoked_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "revoked_sessions_expires_at_idx" ON "revoked_sessions"("expires_at");

-- Fence late completions from a superseded generation attempt.
ALTER TABLE "itinerary_generations" ADD COLUMN "attempt_id" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "itinerary_generations" ALTER COLUMN "attempt_id" DROP DEFAULT;
