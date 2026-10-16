import { Prisma } from '../generated/prisma/client.ts';
import { prisma } from '../lib/prisma.ts';
import { PlatformActionError } from '../exceptions/index.ts';
import { activityDescriptions, activityPrefixes, describeActivity, matchingActivityCodes } from '../services/platform/activity-presentation.ts';
import type { Role } from '../schemas/domain.ts';

type ActivityRow = { id: string; actorId: string | null; action: string; targetId: string; createdAt: Date; userId: string | null; actorName: string | null; actorRole: string | null };
export const ACTIVITY_PAGE_SIZE = 10;
const literalPattern = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

export async function readActivityLog(params: URLSearchParams) {
  const query = (params.get('q') || '').trim();
  const rawPage = params.get('page') || '1';
  if (query.length > 200 || !/^[1-9]\d{0,6}$/.test(rawPage) || Number(rawPage) > 1_000_000) throw new PlatformActionError('Use a search of at most 200 characters and a valid page number.');
  const pattern = literalPattern(query);
  const codeMatches = matchingActivityCodes(query).map(code => code.endsWith(':')
    ? Prisma.sql`a.action LIKE ${code.replace(/[\\%_]/g, '\\$&') + '%'}`
    : Prisma.sql`a.action = ${code}`);
  if (query && 'other activity'.includes(query.toLowerCase())) {
    const prefixes = Object.keys(activityPrefixes).map(prefix => Prisma.sql`a.action LIKE ${prefix + '%'}`);
    codeMatches.push(Prisma.sql`NOT (a.action IN (${Prisma.join(Object.keys(activityDescriptions))}) OR ${Prisma.join(prefixes, ' OR ')})`);
  }
  const where = query ? Prisma.sql`WHERE (u.name ILIKE ${pattern} OR a.target_id ILIKE ${pattern} OR a.id ILIKE ${pattern}
    OR split_part(a.action, ':', 1) ILIKE ${pattern}
    ${codeMatches.length ? Prisma.sql`OR (${Prisma.join(codeMatches, ' OR ')})` : Prisma.empty})` : Prisma.empty;

  return prisma.$transaction(async tx => {
    // Explicit LEFT JOIN follows the actor FK, never the polymorphic target ID.
    // It also retains legacy rows whose account is unavailable.
    const [count] = await tx.$queryRaw<Array<{ total: bigint }>>`SELECT COUNT(*) AS total FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where}`;
    const total = Number(count.total);
    const page = Math.min(Number(rawPage), Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE)));
    const rows = await tx.$queryRaw<ActivityRow[]>`SELECT a.id, a.actor_id AS "actorId", a.action, a.target_id AS "targetId", a.created_at AS "createdAt",
      u.id AS "userId", u.name AS "actorName", u.role::text AS "actorRole"
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${ACTIVITY_PAGE_SIZE} OFFSET ${(page - 1) * ACTIVITY_PAGE_SIZE}`;
    return { entries: rows.map(row => ({
      id: row.id, createdAt: row.createdAt.toISOString(), targetId: row.targetId,
      actionLabel: describeActivity(row.action).label, targetType: describeActivity(row.action).targetType, tone: describeActivity(row.action).tone,
      actor: row.userId && row.actorName && (row.actorRole === 'admin' || row.actorRole === 'traveler')
        ? { id: row.userId, name: row.actorName, role: row.actorRole as Role } : null,
      actorUnavailableReason: row.userId && row.actorName ? null : row.actorId ? 'account-unavailable' as const : 'not-recorded' as const,
    })), total, page, pageSize: ACTIVITY_PAGE_SIZE };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
