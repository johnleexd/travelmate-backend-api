CREATE TYPE "FeedbackSentiment" AS ENUM ('positive', 'neutral', 'negative');
CREATE TYPE "FeedbackCategory" AS ENUM ('budget_accuracy', 'weather_info', 'ai_cohesion', 'route_efficiency');
CREATE TABLE "feedback" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "itinerary_id" TEXT,
  "rating" INTEGER NOT NULL CHECK ("rating" BETWEEN 1 AND 5),
  "sentiment" "FeedbackSentiment" NOT NULL,
  "category" "FeedbackCategory" NOT NULL,
  "comment" TEXT NOT NULL CHECK (char_length(btrim("comment")) BETWEEN 10 AND 2000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "feedback_itinerary_id_fkey" FOREIGN KEY ("itinerary_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "feedback_created_at_id_idx" ON "feedback"("created_at" DESC, "id");
CREATE INDEX "feedback_rating_sentiment_created_at_idx" ON "feedback"("rating", "sentiment", "created_at" DESC);
CREATE INDEX "feedback_user_id_idx" ON "feedback"("user_id");
CREATE INDEX "feedback_itinerary_id_idx" ON "feedback"("itinerary_id");
