import { prisma } from '../../lib/prisma.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';

export function appealMessage(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 10 || text.length > 2000) throw new PlatformActionError('Message must be between 10 and 2000 characters.');
  return text;
}

export async function submitAppeal(user: PublicUser, body: Record<string, unknown>) {
  if (user.role !== 'traveler' || user.accountStatus !== 'suspended') throw new PlatformActionError('Only suspended travelers can submit an appeal.');
  const details = appealMessage(body.message);
  return prisma.$transaction(async tx => {
    // Lock the account so concurrent submissions and account restoration cannot
    // create an appeal against an outdated account state.
    const account = await tx.user.updateMany({ where: { id: user.id, role: 'traveler', accountStatus: 'suspended' }, data: { accountStatus: 'suspended' } });
    if (!account.count) throw new PlatformActionError('Your account is no longer suspended.');
    if (await tx.moderation.findFirst({ where: { kind: 'appeal', subjectId: user.id, status: 'pending' } })) throw new PlatformActionError('Your appeal is already awaiting admin review.');
    const appeal = await tx.moderation.create({ data: { kind: 'appeal', subjectId: user.id, title: 'Account suspension appeal', details, status: 'pending' } });
    const admins = await tx.user.findMany({ where: { role: 'admin', accountStatus: 'active' }, select: { id: true } });
    if (admins.length) await tx.notification.createMany({ data: admins.map(admin => ({ userId: admin.id, title: 'Suspension appeal received', body: `${user.name} submitted an account suspension appeal. Review it in Reports & appeals.`, href: '/admin/dashboard' })) });
    await tx.notification.create({ data: { userId: user.id, title: 'Appeal received', body: 'Your suspension appeal has been sent to the admins for review. You can check its status on this page.', href: '/account/appeal' } });
    await tx.auditEvent.create({ data: { actorId: user.id, action: 'submit-appeal', targetId: appeal.id } });
    return appeal;
  });
}

export async function reviewAppeal(user: PublicUser, body: Record<string, unknown>) {
  if (user.role !== 'admin') throw new PlatformActionError('Only admins can review appeals.');
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id || !['approved', 'rejected'].includes(String(body.decision))) throw new PlatformActionError('Choose an appeal and a valid decision.');
  const note = appealMessage(body.message);
  const status = body.decision === 'approved' ? 'approved' : 'rejected';
  return prisma.$transaction(async tx => {
    const appeal = await tx.moderation.findFirst({ where: { id, kind: 'appeal', status: 'pending' } });
    if (!appeal) throw new PlatformActionError('Pending appeal not found.');
    const account = await tx.user.updateMany({ where: { id: appeal.subjectId, role: 'traveler', accountStatus: 'suspended' }, data: { accountStatus: status === 'approved' ? 'active' : 'suspended' } });
    if (!account.count) throw new PlatformActionError('This account is no longer suspended. Refresh the appeal list.');
    const updated = await tx.moderation.updateMany({ where: { id, kind: 'appeal', status: 'pending' }, data: { status } });
    if (!updated.count) throw new PlatformActionError('This appeal has already been reviewed.');
    await tx.notification.create({ data: { userId: appeal.subjectId, title: status === 'approved' ? 'Appeal approved — account restored' : 'Appeal decision — suspension remains', body: note, href: status === 'approved' ? '/dashboard' : '/account/appeal' } });
    await tx.auditEvent.create({ data: { actorId: user.id, action: `appeal-${status}`, targetId: id } });
    return { id, status };
  });
}
