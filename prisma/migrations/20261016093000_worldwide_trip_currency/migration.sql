-- Currency membership is validated against the shared ISO catalogue by the API.
-- Keep the database format constraint without the obsolete 20-currency subset.
ALTER TABLE "trips" DROP CONSTRAINT "trips_currency_check";
ALTER TABLE "trips" ADD CONSTRAINT "trips_currency_check"
  CHECK ("currency" ~ '^[A-Z]{3}$');
