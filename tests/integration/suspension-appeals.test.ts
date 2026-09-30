import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { submitAppeal } from '../../src/services/platform/appeal-service.ts';
import { currentUser, createSessionToken, requireUser } from '../../src/middlewares/auth-middleware.ts';
import { GET as getAppeal } from '../../src/controllers/appeal-controller.ts';
import { POST as auth } from '../../src/controllers/auth-controller.ts';
import { password } from '../../src/repositories/platform-repository.ts';

test('suspension permits only appeals; decisions notify the traveler and approval restores access', async () => {
  const marker = Date.now();
  const ids: string[] = [];
  const noticeName = `Appeal Test ${marker}`;
  try {
    const admin = await prisma.user.create({ data: { name: 'Appeal Test Admin', email: `appeal-admin-${marker}@example.test`, role: 'admin', emailVerified: true } }); ids.push(admin.id);
    const traveler = await prisma.user.create({ data: { name: noticeName, email: `appeal-${marker}@example.test`, role: 'traveler', emailVerified: true, passwordSalt: 'test-salt', passwordHash: password('Travel123!', 'test-salt') } }); ids.push(traveler.id);
    const request = new Request('http://localhost/api/account/appeal', { headers: { cookie: `travelmate_session=${createSessionToken(traveler.id, 'traveler')}` } });
    await executePlatformAction(publicUser(admin), 'admin-user-status', { id: traveler.id, status: 'suspended' });
    assert.equal(await currentUser(request), null);
    await assert.rejects(() => requireUser(request), /UNAUTHORIZED/);
    const suspended = await currentUser(request, 'traveler', true);
    assert.equal(suspended?.accountStatus, 'suspended');
    const login = await auth(new Request('http://localhost/api/auth', { method: 'POST', body: JSON.stringify({ action: 'login', email: traveler.email, password: 'Travel123!' }) }));
    assert.equal(login.status, 200);
    assert.equal((await login.json()).redirect, '/account/appeal');
    assert.ok(login.headers.get('set-cookie'));
    assert.equal((await getAppeal(request)).status, 200);
    const appeal = await submitAppeal(suspended!, { message: 'Please review my suspension. I understand the guidance.' });
    await assert.rejects(() => submitAppeal(suspended!, { message: 'Please review my suspension again.' }), /already awaiting/);
    assert.ok(await prisma.notification.findFirst({ where: { userId: admin.id, title: 'Suspension appeal received', body: { contains: noticeName } } }));
    await assert.rejects(() => executePlatformAction(suspended!, 'review-appeal', { id: appeal.id, decision: 'approved', message: 'Restore my own account please.' }), /Only admins/);
    await executePlatformAction(publicUser(admin), 'review-appeal', { id: appeal.id, decision: 'rejected', message: 'Please provide more details about the issue.' });
    assert.equal(await currentUser(request), null);
    assert.ok(await prisma.notification.findFirst({ where: { userId: traveler.id, title: 'Appeal decision — suspension remains' } }));
    const second = await submitAppeal(suspended!, { message: 'Here are the additional details requested for my appeal.' });
    await executePlatformAction(publicUser(admin), 'review-appeal', { id: second.id, decision: 'approved', message: 'Your additional details were accepted. Access restored.' });
    assert.equal((await requireUser(request)).accountStatus, 'active');
    await assert.rejects(() => executePlatformAction(publicUser(admin), 'review-appeal', { id: second.id, decision: 'approved', message: 'Your account access is restored.' }), /Pending appeal not found/);
    const data = await (await getAppeal(request)).json();
    assert.equal(data.appeals.length, 2);
    assert.ok(data.notifications.some((item: { title: string }) => item.title === 'Appeal approved — account restored'));
  } finally {
    await prisma.notification.deleteMany({ where: { title: 'Suspension appeal received', body: { contains: noticeName } } });
    await prisma.moderation.deleteMany({ where: { kind: 'appeal', subjectId: { in: ids } } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
