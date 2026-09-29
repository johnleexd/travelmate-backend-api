ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'declined';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PENDING';

ALTER TABLE "listings"
  ADD COLUMN "image_urls" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "bookings"
  ADD COLUMN "check_in" DATE,
  ADD COLUMN "check_out" DATE,
  ADD COLUMN "notes" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "requested_check_in" DATE,
  ADD COLUMN "requested_check_out" DATE,
  ADD COLUMN "requested_guests" INTEGER,
  ADD COLUMN "request_note" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "listing_blocked_dates" (
  "id" TEXT NOT NULL,
  "listing_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "listing_blocked_dates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "promotions" (
  "id" TEXT NOT NULL,
  "listing_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "discount_pct" INTEGER NOT NULL,
  "start_date" DATE NOT NULL,
  "end_date" DATE NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reviews" (
  "id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "listing_id" TEXT NOT NULL,
  "traveler_id" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "href" TEXT NOT NULL DEFAULT '',
  "read_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_transactions" (
  "id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "owner_documents" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "file_url" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "owner_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "listing_blocked_dates_listing_id_date_key" ON "listing_blocked_dates"("listing_id", "date");
CREATE INDEX "listing_blocked_dates_date_idx" ON "listing_blocked_dates"("date");
CREATE INDEX "promotions_listing_id_active_start_date_end_date_idx" ON "promotions"("listing_id", "active", "start_date", "end_date");
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");
CREATE INDEX "reviews_listing_id_created_at_idx" ON "reviews"("listing_id", "created_at");
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");
CREATE INDEX "payment_transactions_booking_id_created_at_idx" ON "payment_transactions"("booking_id", "created_at");
CREATE INDEX "owner_documents_owner_id_status_idx" ON "owner_documents"("owner_id", "status");

ALTER TABLE "listing_blocked_dates" ADD CONSTRAINT "listing_blocked_dates_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_traveler_id_fkey" FOREIGN KEY ("traveler_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "owner_documents" ADD CONSTRAINT "owner_documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
