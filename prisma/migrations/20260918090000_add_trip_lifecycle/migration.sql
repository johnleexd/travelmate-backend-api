CREATE TYPE "TripStatus" AS ENUM ('active', 'archived');
CREATE TYPE "ItineraryVersionKind" AS ENUM ('saved', 'regenerated', 'manual_edit', 'duplicated', 'restored');
CREATE TYPE "GenerationStatus" AS ENUM ('pending', 'completed', 'failed');

ALTER TABLE "trips"
ADD COLUMN "status" "TripStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "archived_at" TIMESTAMPTZ(6),
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "itinerary_versions" (
  "id" TEXT NOT NULL,
  "trip_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" "ItineraryVersionKind" NOT NULL,
  "itinerary" JSONB NOT NULL,
  "weather" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "itinerary_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "itinerary_generations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "idempotency_key" VARCHAR(100) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "destination" VARCHAR(120) NOT NULL,
  "status" "GenerationStatus" NOT NULL DEFAULT 'pending',
  "response" JSONB,
  "error_code" VARCHAR(80),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "itinerary_generations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "itinerary_versions_trip_id_version_key" ON "itinerary_versions"("trip_id", "version");
CREATE INDEX "itinerary_versions_trip_id_created_at_idx" ON "itinerary_versions"("trip_id", "created_at" DESC);
CREATE UNIQUE INDEX "itinerary_generations_user_id_idempotency_key_key" ON "itinerary_generations"("user_id", "idempotency_key");
CREATE INDEX "itinerary_generations_user_id_created_at_idx" ON "itinerary_generations"("user_id", "created_at" DESC);
CREATE INDEX "trips_user_id_status_idx" ON "trips"("user_id", "status");

ALTER TABLE "itinerary_versions" ADD CONSTRAINT "itinerary_versions_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "itinerary_generations" ADD CONSTRAINT "itinerary_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "itinerary_versions" ("id", "trip_id", "version", "kind", "itinerary", "weather", "created_at")
SELECT md5(random()::text || clock_timestamp()::text || "id"), "id", 1, 'saved'::"ItineraryVersionKind", "itinerary", "weather", "created_at"
FROM "trips";
