CREATE UNIQUE INDEX "one_pending_appeal_per_user" ON "moderation" ("subject_id") WHERE "kind" = 'appeal' AND "status" = 'pending';
