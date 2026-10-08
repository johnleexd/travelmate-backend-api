ALTER TYPE "FeedbackSentiment" ADD VALUE IF NOT EXISTS 'not_analyzed';
ALTER TABLE "feedback" ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "feedback_user_id_itinerary_id_key" ON "feedback"("user_id", "itinerary_id");
