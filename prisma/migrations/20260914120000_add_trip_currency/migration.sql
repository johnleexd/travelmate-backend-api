ALTER TABLE "trips"
ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'PHP';

ALTER TABLE "trips"
ADD CONSTRAINT "trips_currency_check"
CHECK ("currency" IN ('PHP', 'USD', 'EUR', 'JPY'));
