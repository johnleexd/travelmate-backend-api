-- Optional metadata retains compatibility with every existing visit record.
ALTER TABLE "visited_places"
  ADD COLUMN "place" JSONB,
  ADD COLUMN "image_url" VARCHAR(1000),
  ADD COLUMN "image_attribution" JSONB;
