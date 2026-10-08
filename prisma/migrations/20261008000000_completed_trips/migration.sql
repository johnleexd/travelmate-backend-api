-- Preserve saved plans and version history while recording completed travel.
ALTER TYPE "TripStatus" ADD VALUE 'completed';
ALTER TABLE "trips" ADD COLUMN "completed_at" TIMESTAMPTZ(6);
