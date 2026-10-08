-- Existing labels were inferred from stars, not analyzed from comments.
ALTER TABLE "feedback" ALTER COLUMN "sentiment" SET DEFAULT 'not_analyzed';
UPDATE "feedback" SET "sentiment" = 'not_analyzed';
