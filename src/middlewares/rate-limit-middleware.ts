import { prisma } from '../lib/prisma.ts';

type BucketRow = { count: number; reset_at: Date };

/** PostgreSQL-backed fixed-window limiter shared by every application instance. */
export async function allowRequest(key: string, limit = 20, windowMs = 60_000): Promise<boolean> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const normalizedKey = key.slice(0, 300);
  const rows = await prisma.$queryRaw<BucketRow[]>`
    INSERT INTO "rate_limit_buckets" ("key", "count", "reset_at")
    VALUES (${normalizedKey}, 1, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."reset_at" <= ${now} THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "reset_at" = CASE WHEN "rate_limit_buckets"."reset_at" <= ${now} THEN ${resetAt} ELSE "rate_limit_buckets"."reset_at" END
    RETURNING "count", "reset_at"
  `;
  if (Math.random() < 0.01) void prisma.$executeRaw`DELETE FROM "rate_limit_buckets" WHERE "reset_at" < ${new Date(now.getTime() - 86_400_000)}`.catch(() => undefined);
  return (rows[0]?.count ?? limit + 1) <= limit;
}
