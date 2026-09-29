-- Keep historical moderation records while supporting traveler problem reports.
ALTER TYPE "ModerationKind" ADD VALUE IF NOT EXISTS 'report';
