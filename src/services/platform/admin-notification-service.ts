import { createHash } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.ts';

type NotificationDb = Pick<Prisma.TransactionClient, 'user' | 'notification'>;
export type AdminNotificationCategory = 'appeals' | 'reports' | 'system' | 'feedback';
export async function notifyAdmins(db: NotificationDb, category: AdminNotificationCategory, title: string, body: string, feedbackId?: string) {
  const admins = await db.user.findMany({ where: { role: 'admin', accountStatus: 'active' }, select: { id: true } });
  if (!admins.length) return;
  const tab = category === 'feedback' ? 'feedback' : category === 'system' ? 'health' : 'reports';
  // A stable primary key makes concurrent submissions and retries idempotent.
  // It does not depend on readAt, so reading a notification never reissues it.
  await db.notification.createMany({
    skipDuplicates: true,
    data: admins.map(admin => ({
      ...(feedbackId ? { id: createHash('sha256').update(JSON.stringify(['feedback-notification-v1', admin.id, feedbackId])).digest('hex') } : {}),
      userId: admin.id, title, body,
      href: '/admin/dashboard?tab=' + tab + '&category=' + category + (feedbackId ? '&feedbackId=' + encodeURIComponent(feedbackId) : ''),
    })),
  });
}
