BEGIN;
ALTER TABLE "trips" DROP CONSTRAINT "trips_date_range_check";
ALTER TABLE "trips" ADD CONSTRAINT "trips_date_range_check"
  CHECK ("end_date" >= "start_date" AND "end_date" <= "start_date" + 30);
COMMIT;
