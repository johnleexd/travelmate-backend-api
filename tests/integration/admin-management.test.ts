import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { GET } from '../../src/controllers/platform-controller.ts';
import { PATCH } from '../../src/controllers/profile-controller.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';

test('admin directory and own profile use database metadata and retain authorization/protections', async () => {
  const ids: string[] = [];
  try {
    const create = async (role: 'admin' | 'traveler', suffix: string) => {
      const row = await prisma.user.create({ data: { name: 'Metadata Test', email: `metadata-${Date.now()}-${suffix}@example.test`, role, emailVerified: true } });
      ids.push(row.id); return row;
    };
    const admin = await create('admin', 'admin');
    const traveler = await create('traveler', 'traveler');
    const cookie = (user: typeof admin) => `travelmate_session=${createSessionToken(user.id, user.role)}`;
    const joined = traveler.createdAt!.toISOString();
    assert.ok(Math.abs(Date.now() - traveler.createdAt!.getTime()) < 60_000);
    const response = await PATCH(new Request('http://localhost/api/profile', { method: 'PATCH', headers: { cookie: cookie(traveler), 'Content-Type': 'application/json' }, body: JSON.stringify({ avatarUrl: 'https://example.test/photo.jpg', name: 'Updated Traveler', role: 'admin', id: admin.id, createdAt: '2000-01-01' }) }));
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.profile.role, 'traveler');
    assert.equal(updated.profile.createdAt, joined);
    assert.equal(updated.profile.avatarUrl, 'https://example.test/photo.jpg');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).name, 'Metadata Test');
    const directoryResponse = await GET(new Request('http://localhost/api/platform?scope=admin', { headers: { cookie: cookie(admin) } }));
    assert.equal(directoryResponse.status, 200);
    const data = await directoryResponse.json();
    const entry = data.directory.find((item: { id: string }) => item.id === traveler.id);
    assert.equal(entry.createdAt, joined);
    assert.equal(entry.avatarUrl, 'https://example.test/photo.jpg');
    assert.equal(data.metrics.activeUsers, data.directory.filter((item: { accountStatus: string }) => item.accountStatus === 'active').length);
    assert.equal('passwordHash' in entry, false);
    assert.equal((await GET(new Request('http://localhost/api/platform?scope=admin', { headers: { cookie: cookie(traveler) } }))).status, 401);
    await assert.rejects(() => executePlatformAction(publicUser(traveler), 'admin-user-status', { id: admin.id, status: 'suspended' }), /not allowed/);
    await assert.rejects(() => executePlatformAction(publicUser(admin), 'admin-user-status', { id: admin.id, status: 'suspended' }), /Managed user not found/);
    await executePlatformAction(publicUser(admin), 'admin-user-status', { id: traveler.id, status: 'suspended' });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: traveler.id } })).accountStatus, 'suspended');
    await executePlatformAction(publicUser(admin), 'admin-user-status', { id: traveler.id, status: 'active' });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: traveler.id } })).accountStatus, 'active');
    await prisma.user.update({ where: { id: traveler.id }, data: { createdAt: null } });
    assert.equal(publicUser(await prisma.user.findUniqueOrThrow({ where: { id: traveler.id } })).createdAt, undefined);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
