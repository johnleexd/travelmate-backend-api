CREATE TABLE "user_feedback" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "comment" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_feedback_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);

CREATE INDEX "user_feedback_created_at_idx" ON "user_feedback"("created_at" DESC);
CREATE INDEX "user_feedback_user_id_created_at_idx" ON "user_feedback"("user_id", "created_at" DESC);
CREATE INDEX "user_feedback_trip_id_idx" ON "user_feedback"("trip_id");

ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
