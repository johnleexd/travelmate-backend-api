CREATE TYPE "PartyType" AS ENUM ('solo', 'couple', 'family', 'friends');

ALTER TABLE "trips" ADD COLUMN "party_type" "PartyType" NOT NULL DEFAULT 'solo';
UPDATE "trips" SET "party_type" = CASE WHEN "travelers" = 1 THEN 'solo'::"PartyType" WHEN "travelers" = 2 THEN 'couple'::"PartyType" ELSE 'friends'::"PartyType" END;

ALTER TABLE "users" ADD CONSTRAINT "users_trust_score_check" CHECK ("trust_score" BETWEEN 0 AND 100);
ALTER TABLE "listings" ADD CONSTRAINT "listings_price_check" CHECK ("price" >= 0);
ALTER TABLE "listings" ADD CONSTRAINT "listings_capacity_check" CHECK ("capacity" > 0);
ALTER TABLE "listings" ADD CONSTRAINT "listings_available_check" CHECK ("available" >= 0 AND "available" <= "capacity");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guests_check" CHECK ("guests" > 0);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_nights_check" CHECK ("nights" > 0);
ALTER TABLE "trips" ADD CONSTRAINT "trips_budget_check" CHECK ("budget" > 0);
ALTER TABLE "trips" ADD CONSTRAINT "trips_travelers_check" CHECK ("travelers" BETWEEN 1 AND 20);
ALTER TABLE "trips" ADD CONSTRAINT "trips_date_range_check" CHECK ("end_date" >= "start_date" AND "end_date" <= "start_date" + 13);
ALTER TABLE "trips" ADD CONSTRAINT "trips_coordinates_check" CHECK (("latitude" IS NULL AND "longitude" IS NULL) OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));

CREATE TABLE "rate_limit_buckets" (
  "key" VARCHAR(300) NOT NULL,
  "count" INTEGER NOT NULL,
  "reset_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "rate_limit_buckets_count_check" CHECK ("count" > 0)
);
CREATE INDEX "rate_limit_buckets_reset_at_idx" ON "rate_limit_buckets"("reset_at");
