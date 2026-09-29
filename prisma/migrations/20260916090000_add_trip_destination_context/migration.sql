ALTER TABLE "trips"
ADD COLUMN "destination_city" TEXT,
ADD COLUMN "destination_region" TEXT,
ADD COLUMN "destination_country" TEXT,
ADD COLUMN "destination_country_code" VARCHAR(2),
ADD COLUMN "latitude" DECIMAL(9, 6),
ADD COLUMN "longitude" DECIMAL(9, 6);

ALTER TABLE "trips"
DROP CONSTRAINT "trips_currency_check";

ALTER TABLE "trips"
ADD CONSTRAINT "trips_currency_check"
CHECK ("currency" IN ('PHP', 'USD', 'EUR', 'JPY', 'KRW', 'THB', 'GBP', 'AUD', 'CAD', 'SGD', 'CNY', 'HKD', 'TWD', 'MYR', 'IDR', 'VND', 'INR', 'NZD', 'CHF', 'AED'));

ALTER TABLE "trips"
ADD CONSTRAINT "trips_destination_country_code_check"
CHECK ("destination_country_code" IS NULL OR "destination_country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "trips"
ADD CONSTRAINT "trips_destination_latitude_check"
CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));

ALTER TABLE "trips"
ADD CONSTRAINT "trips_destination_longitude_check"
CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
