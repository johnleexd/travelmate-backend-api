import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { GET } from '../../src/controllers/platform-controller.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';

test('admin warnings persist only for the selected traveler and record an audit event', async () => {
  const marker = Date.now();
  const created: string[] = [];
  try {
    const create = async (role: 'traveler' | 'admin', suffix: string) => {
      const user = await prisma.user.create({ data: { name: 'Warning test', email: `warning-${marker}-${suffix}@example.test`, role, emailVerified: true } });
      created.push(user.id);
      return user;
    };
    const admin = await create('admin', 'admin');
    const traveler = await create('traveler', 'recipient');
    const other = await create('traveler', 'other');
    const message = 'Please avoid submitting repeated reports for the same issue.';
    await assert.rejects(() => executePlatformAction(publicUser(traveler), 'admin-user-warning', { id: other.id, message }), /Only admins/);
    await assert.rejects(() => executePlatformAction(publicUser(admin), 'admin-user-warning', { id: admin.id, message }), /Traveler not found/);
    const result = await executePlatformAction(publicUser(admin), 'admin-user-warning', { id: traveler.id, message }) as { id: string };
    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: result.id } });
    assert.equal(notification.body, message);
    assert.equal(notification.readAt, null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: traveler.id } })).accountStatus, 'active');
    for (const user of [traveler, other]) {
      const response = await GET(new Request('http://localhost/api/platform', { headers: { cookie: `travelmate_session=${createSessionToken(user.id, user.role)}` } }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.notifications.some((item: { id: string }) => item.id === result.id), user.id === traveler.id);
    }
    assert.equal(await prisma.auditEvent.count({ where: { actorId: admin.id, action: 'admin-user-warning', targetId: traveler.id } }), 1);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  }
});
