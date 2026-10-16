-- Additive only: existing generations remain unmetered, with no invented usage.
CREATE TYPE "AllowanceState" AS ENUM ('reserved', 'processing', 'succeeded', 'failed', 'reconciled');
CREATE TYPE "SubscriptionSource" AS ENUM ('verified_payment', 'admin_demo');
ALTER TABLE "itinerary_generations"
  ADD COLUMN "allowance_period" TIMESTAMPTZ(6),
  ADD COLUMN "allowance_state" "AllowanceState",
  ADD COLUMN "reserved_until" TIMESTAMPTZ(6),
  ADD COLUMN "charged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "operation_kind" VARCHAR(30) NOT NULL DEFAULT 'itinerary',
  ADD COLUMN "related_trip_id" TEXT;
CREATE INDEX "itinerary_generations_user_id_allowance_period_allowance_state_idx"
  ON "itinerary_generations" ("user_id", "allowance_period", "allowance_state");
CREATE UNIQUE INDEX "one_active_allowance_per_user" ON "itinerary_generations" ("user_id")
  WHERE "allowance_state" IN ('reserved', 'processing');
ALTER TABLE "itinerary_generations" ADD CONSTRAINT "allowance_charge_requires_success"
  CHECK (NOT "charged" OR ("allowance_state" = 'succeeded' AND "status" = 'completed' AND "response" IS NOT NULL));
CREATE TABLE "plan_subscriptions" (
  "user_id" TEXT PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "source" "SubscriptionSource" NOT NULL,
  "activation_key" VARCHAR(100) NOT NULL UNIQUE,
  "actor_id" TEXT REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" TEXT,
  "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscription_dates" CHECK ("expires_at" > "starts_at"),
  CONSTRAINT "demo_grant_audit" CHECK ("source" <> 'admin_demo' OR ("actor_id" IS NOT NULL AND length(trim("reason")) > 0))
);
CREATE TABLE "generation_tracking" ("id" TEXT PRIMARY KEY, "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "generation_tracking" ("id") VALUES ('monthly-v1');
-- Keep immutable grant identities even after an entitlement is extended.
CREATE TABLE "plan_activations" (
  "key" VARCHAR(100) PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
