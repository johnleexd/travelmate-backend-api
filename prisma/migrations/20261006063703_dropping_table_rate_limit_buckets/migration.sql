/*
  Warnings:

  - You are about to drop the `rate_limit_buckets` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "bookings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "itinerary_generations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "trips" ALTER COLUMN "updated_at" DROP DEFAULT;

-- DropTable
DROP TABLE "rate_limit_buckets";
