import { prisma } from '../../lib/prisma.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';

export function validateWarning(body: Record<string, unknown>) {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!id) throw new PlatformActionError('A traveler is required.');
  if (message.length < 10 || message.length > 2000) throw new PlatformActionError('Warning must be between 10 and 2000 characters.');
  return { id, message };
}

export async function sendUserWarning(user: PublicUser, body: Record<string, unknown>) {
  if (user.role !== 'admin') throw new PlatformActionError('Only admins can send account warnings.');
  const { id, message } = validateWarning(body);
  return prisma.$transaction(async transaction => {
    const target = await transaction.user.findFirst({ where: { id, role: 'traveler' }, select: { id: true } });
    if (!target) throw new PlatformActionError('Traveler not found.');
    const notification = await transaction.notification.create({ data: {
      userId: target.id, title: 'Account warning from TravelMate', body: message, href: '/dashboard?tab=notifications',
    } });
    await transaction.auditEvent.create({ data: { actorId: user.id, action: 'admin-user-warning', targetId: target.id } });
    return { id: notification.id, userId: target.id };
  });
}
