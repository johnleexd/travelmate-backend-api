CREATE TYPE "AccountTokenKind" AS ENUM ('email_verification', 'password_reset');

ALTER TABLE "users"
ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "account_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" "AccountTokenKind" NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens"("token_hash");
CREATE UNIQUE INDEX "account_tokens_user_id_kind_key" ON "account_tokens"("user_id", "kind");
CREATE INDEX "account_tokens_expires_at_idx" ON "account_tokens"("expires_at");

ALTER TABLE "account_tokens"
ADD CONSTRAINT "account_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
