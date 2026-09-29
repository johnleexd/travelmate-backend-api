import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { GET } from '../../src/controllers/platform-controller.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';

test('traveler reports persist, remain private, and can only be resolved by an admin', async () => {
  const marker = Date.now();
  const traveler = await prisma.user.create({ data: { name: 'Report Test', email: `report-${marker}@example.test`, role: 'traveler', emailVerified: true } });
  const admin = await prisma.user.create({ data: { name: 'Report Admin', email: `report-admin-${marker}@example.test`, role: 'admin', emailVerified: true } });
  let reportId = '';
  try {
    const report = await executePlatformAction(publicUser(traveler), 'submit-report', { title: 'Cannot open saved trip', details: 'Opening my trip displays a blank page.' }) as { id: string; status: string };
    reportId = report.id;
    assert.equal(report.status, 'pending');
    const fetchData = async (user: typeof traveler) => {
      const response = await GET(new Request('http://localhost/api/platform', { headers: { cookie: `travelmate_session=${createSessionToken(user.id, user.role)}` } }));
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await fetchData(traveler)).moderation.length, 0);
    const adminData = await fetchData(admin);
    assert.ok(adminData.moderation.some((item: { id: string }) => item.id === reportId));
    assert.ok(adminData.moderation.every((item: { kind: string }) => item.kind === 'report'));
    assert.equal(adminData.bookings.length, 0);
    await assert.rejects(() => executePlatformAction(publicUser(traveler), 'resolve-report', { id: reportId }), /Only admins/);
    await executePlatformAction(publicUser(admin), 'resolve-report', { id: reportId });
    assert.equal((await prisma.moderation.findUniqueOrThrow({ where: { id: reportId } })).status, 'resolved');
    await assert.rejects(() => executePlatformAction(publicUser(admin), 'moderate', { id: reportId }), /no longer available/);
    await assert.rejects(() => executePlatformAction(publicUser(traveler), 'submit-profile', {}), /no longer available/);
  } finally {
    if (reportId) await prisma.moderation.deleteMany({ where: { id: reportId } });
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: [traveler.id, admin.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [traveler.id, admin.id] } } });
  }
});
