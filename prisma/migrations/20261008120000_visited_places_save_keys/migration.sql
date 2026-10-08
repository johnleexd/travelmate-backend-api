ALTER TABLE "trips" ADD COLUMN "save_key" VARCHAR(100), ADD COLUMN "save_request_hash" VARCHAR(64);
CREATE UNIQUE INDEX "trips_user_id_save_key_key" ON "trips"("user_id", "save_key");
CREATE TABLE "visited_places" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL, "trip_id" TEXT,
  "place_key" VARCHAR(100) NOT NULL, "name" VARCHAR(160) NOT NULL,
  "destination" VARCHAR(120) NOT NULL, "visit_date" DATE NOT NULL,
  "latitude" DOUBLE PRECISION, "longitude" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "visited_places_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "visited_places_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "visited_places_user_id_place_key_visit_date_key" ON "visited_places"("user_id", "place_key", "visit_date");
CREATE INDEX "visited_places_user_id_visit_date_id_idx" ON "visited_places"("user_id", "visit_date" DESC, "id");
