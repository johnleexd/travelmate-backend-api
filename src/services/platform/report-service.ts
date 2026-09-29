import { prisma } from '../../lib/prisma.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';

export function validateReport(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const details = typeof body.details === 'string' ? body.details.trim() : '';
  if (title.length < 5 || title.length > 120) throw new PlatformActionError('Report subject must be between 5 and 120 characters.');
  if (details.length < 10 || details.length > 2000) throw new PlatformActionError('Report details must be between 10 and 2000 characters.');
  return { title, details };
}

export async function submitReport(user: PublicUser, body: Record<string, unknown>) {
  if (user.role !== 'traveler') throw new PlatformActionError('Only travelers can submit problem reports.');
  const input = validateReport(body);
  const report = await prisma.$transaction(async transaction => {
    const created = await transaction.moderation.create({ data: { ...input, kind: 'report', subjectId: user.id, status: 'pending' } });
    await transaction.auditEvent.create({ data: { actorId: user.id, action: 'submit-report', targetId: created.id } });
    return created;
  });
  return { ...report, createdAt: report.createdAt.toISOString() };
}

export async function resolveReport(user: PublicUser, body: Record<string, unknown>) {
  if (user.role !== 'admin') throw new PlatformActionError('Only admins can resolve problem reports.');
  if (typeof body.id !== 'string' || !body.id.trim()) throw new PlatformActionError('A report ID is required.');
  const id = body.id.trim();
  return prisma.$transaction(async transaction => {
    const updated = await transaction.moderation.updateMany({ where: { id, kind: 'report', status: 'pending' }, data: { status: 'resolved' } });
    if (updated.count !== 1) throw new PlatformActionError('Open report not found.');
    const report = await transaction.moderation.findUniqueOrThrow({ where: { id } });
    const reporter = await transaction.user.findUnique({ where: { id: report.subjectId }, select: { id: true } });
    if (reporter) await transaction.notification.create({ data: { userId: reporter.id, title: 'Report resolved', body: `An admin marked your report “${report.title}” as resolved. If the issue persists, please send another report.`, href: '/dashboard?tab=profile' } });
    await transaction.auditEvent.create({ data: { actorId: user.id, action: 'resolve-report', targetId: id } });
    return { id, status: 'resolved' };
  });
}
