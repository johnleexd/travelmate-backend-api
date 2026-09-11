CREATE TYPE "Role" AS ENUM ('traveler', 'owner', 'admin');
CREATE TYPE "ProfileStatus" AS ENUM ('unverified', 'pending', 'verified', 'rejected');
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "ListingCategory" AS ENUM ('stay', 'activity', 'food', 'transport');
CREATE TYPE "ListingStatus" AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE "BookingStatus" AS ENUM ('confirmed', 'change_requested', 'cancel_requested', 'cancelled', 'completed');
CREATE TYPE "PaymentStatus" AS ENUM ('PAID_HELD', 'Released', 'FROZEN_HELD', 'REFUNDED');
CREATE TYPE "ModerationKind" AS ENUM ('profile', 'listing', 'dispute');
CREATE TYPE "ModerationStatus" AS ENUM ('pending', 'approved', 'rejected', 'resolved');

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "Role" NOT NULL,
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "profile_status" "ProfileStatus" NOT NULL DEFAULT 'unverified',
  "trust_score" INTEGER NOT NULL DEFAULT 50,
  "account_status" "AccountStatus" NOT NULL DEFAULT 'active',
  "password_hash" TEXT NOT NULL,
  "password_salt" TEXT NOT NULL,
  "bio" TEXT,
  "phone" TEXT,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "listings" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" "ListingCategory" NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "capacity" INTEGER NOT NULL,
  "available" INTEGER NOT NULL,
  "status" "ListingStatus" NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "municipality" TEXT NOT NULL DEFAULT 'Cordova',
  "address" TEXT NOT NULL DEFAULT '',
  "amenities" JSONB NOT NULL DEFAULT '[]',
  "image_url" TEXT,
  CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bookings" (
  "id" TEXT NOT NULL,
  "traveler_id" TEXT NOT NULL,
  "listing_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "guests" INTEGER NOT NULL,
  "nights" INTEGER NOT NULL DEFAULT 1,
  "status" "BookingStatus" NOT NULL,
  "payment_status" "PaymentStatus" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "moderation" (
  "id" TEXT NOT NULL,
  "kind" "ModerationKind" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "details" TEXT NOT NULL,
  "status" "ModerationStatus" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "moderation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "trips" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "budget" DECIMAL(12,2) NOT NULL,
  "start_date" DATE NOT NULL,
  "travelers" INTEGER NOT NULL,
  "interests" JSONB NOT NULL DEFAULT '[]',
  "itinerary" JSONB NOT NULL,
  "weather" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_events" (
  "id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_account_status_idx" ON "users"("account_status");
CREATE INDEX "listings_owner_id_idx" ON "listings"("owner_id");
CREATE INDEX "listings_status_idx" ON "listings"("status");
CREATE INDEX "listings_municipality_category_status_idx" ON "listings"("municipality", "category", "status");
CREATE INDEX "bookings_traveler_id_idx" ON "bookings"("traveler_id");
CREATE INDEX "bookings_listing_id_idx" ON "bookings"("listing_id");
CREATE INDEX "bookings_payment_status_idx" ON "bookings"("payment_status");
CREATE INDEX "moderation_status_idx" ON "moderation"("status");
CREATE INDEX "trips_user_id_idx" ON "trips"("user_id");
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at" DESC);

ALTER TABLE "listings" ADD CONSTRAINT "listings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_traveler_id_fkey" FOREIGN KEY ("traveler_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
