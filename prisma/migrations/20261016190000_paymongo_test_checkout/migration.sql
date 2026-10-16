-- Additive sandbox orders only. Existing subscriptions and usage are preserved.
ALTER TYPE "SubscriptionSource" ADD VALUE 'paymongo_test';
CREATE TABLE "plan_checkout_orders" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'creating',
  "amount" INTEGER NOT NULL CHECK ("amount" >= 100),
  "currency" VARCHAR(3) NOT NULL DEFAULT 'PHP' CHECK ("currency" = 'PHP'),
  "duration_days" INTEGER NOT NULL CHECK ("duration_days" BETWEEN 1 AND 365),
  "session_id" TEXT UNIQUE,
  "payment_intent_id" TEXT UNIQUE,
  "payment_id" TEXT UNIQUE,
  "checkout_url" TEXT,
  "last_error" VARCHAR(80),
  "fulfilled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "test_order_status" CHECK ("status" IN ('creating', 'pending', 'paid', 'failed', 'cancelled', 'expired')),
  CONSTRAINT "test_order_paid_evidence" CHECK ("status" <> 'paid' OR ("payment_id" IS NOT NULL AND "session_id" IS NOT NULL AND "fulfilled_at" IS NOT NULL)),
  UNIQUE ("user_id", "idempotency_key")
);
CREATE INDEX "plan_checkout_orders_user_id_created_at_idx" ON "plan_checkout_orders" ("user_id", "created_at" DESC);
CREATE UNIQUE INDEX "one_active_test_checkout_per_user" ON "plan_checkout_orders" ("user_id") WHERE "status" IN ('creating', 'pending');
