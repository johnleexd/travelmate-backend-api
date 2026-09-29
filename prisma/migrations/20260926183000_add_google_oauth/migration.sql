CREATE TYPE "OAuthProvider" AS ENUM ('google');

ALTER TABLE "users"
  ALTER COLUMN "password_hash" DROP NOT NULL,
  ALTER COLUMN "password_salt" DROP NOT NULL;

CREATE TABLE "oauth_accounts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" "OAuthProvider" NOT NULL,
  "provider_account_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");
CREATE UNIQUE INDEX "oauth_accounts_user_id_provider_key" ON "oauth_accounts"("user_id", "provider");
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

ALTER TABLE "oauth_accounts"
  ADD CONSTRAINT "oauth_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
