ALTER TABLE "trips" ADD COLUMN "end_date" DATE;
UPDATE "trips" SET "end_date" = "start_date" + 6 WHERE "end_date" IS NULL;
ALTER TABLE "trips" ALTER COLUMN "end_date" SET NOT NULL;
