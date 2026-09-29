-- Preserve existing accounts and related data without granting admin access.
UPDATE "users" SET "role" = 'traveler', "session_version" = "session_version" + 1 WHERE "role" = 'owner';
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('traveler', 'admin');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";
