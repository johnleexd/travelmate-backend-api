import assert from 'node:assert/strict';
import test, { after } from 'node:test';
after(() => prisma.$disconnect());
import { prisma } from '../../src/lib/prisma.ts';
import { createSessionToken } from '../../src/middlewares/auth-middleware.ts';
import { GET, POST, ITINERARY, OWN, DETAIL } from '../../src/controllers/feedback-controller.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';
import { readNotificationSnapshot } from '../../src/repositories/trip-workspace-repository.ts';
import { submitFeedback } from '../../src/services/platform/feedback-service.ts';

test('real feedback persists, filters and paginates; admin access and itinerary ownership are enforced', async () => {
  const ids: string[] = [];
  const tripIds: string[] = [];
  const feedbackIds: string[] = [];
  try {
    const createUser = async (role: 'admin' | 'traveler', suffix: string) => {
      const row = await prisma.user.create({ data: { name: 'Feedback Test', email: `feedback-${Date.now()}-${suffix}@example.test`, role, emailVerified: true } });
      ids.push(row.id); return row;
    };
    const admin = await createUser('admin', 'admin');
    const traveler = await createUser('traveler', 'owner');
    const other = await createUser('traveler', 'other');
    const itinerary = { destination: 'Tokyo', totalBudget: 1000, currency: 'JPY', source: 'mock', days: [{ day: 1, date: '2040-01-01', theme: 'Explore Tokyo', imageUrl: '', totalCost: 100, activities: [{ time: '09:00', title: 'Museum visit', description: 'Visit a local museum.', estimatedCost: 100, category: 'activity', icon: 'map' }] }], budgetSummary: { accommodation: 0, food: 0, activities: 100, transport: 0, reserve: 100, dailyAverage: 100, total: 200 } };
    const trip = await prisma.trip.create({ data: { userId: traveler.id, destination: 'Tokyo', budget: 1000, currency: 'JPY', startDate: new Date('2040-01-01'), endDate: new Date('2040-01-01'), travelers: 1, itinerary } });
    tripIds.push(trip.id);
    const headers = (user: typeof admin) => ({ cookie: `travelmate_session=${createSessionToken(user.id, user.role)}`, 'Content-Type': 'application/json' });
    const body = { itineraryId: trip.id, rating: 4, category: 'budget_accuracy', comment: 'The itinerary budget was helpful.' };
    const post = await POST(new Request('http://localhost/api/feedback', { method: 'POST', headers: headers(traveler), body: JSON.stringify({ ...body, userId: other.id, sentiment: 'negative' }) }));
    assert.equal(post.status, 201);
    const created = (await post.json()).result;
    feedbackIds.push(created.id);
    const href = '/admin/dashboard?tab=feedback&category=feedback&feedbackId=' + encodeURIComponent(created.id);
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: admin.id, href } });
    assert.equal(notification.title, 'New feedback received');
    assert.equal(notification.readAt, null);
    const snapshot = await readNotificationSnapshot(publicUser(admin));
    assert.equal(snapshot.unreadCount, 1);
    assert.ok(snapshot.notifications.some(item => item.id === notification.id));
    const full = await DETAIL(new Request('http://localhost/api/feedback/' + created.id, { headers: headers(admin) }));
    assert.equal(full.status, 200);
    const fullEntry = (await full.json()).entry;
    assert.equal(fullEntry.id, created.id); assert.equal(fullEntry.user.id, traveler.id);
    assert.equal(fullEntry.itinerary.id, trip.id); assert.equal(fullEntry.rating, body.rating);
    assert.equal(fullEntry.category, body.category); assert.equal(fullEntry.comment, body.comment);
    assert.equal((await DETAIL(new Request('http://localhost/api/feedback/' + created.id, { headers: headers(traveler) }))).status, 401);
    assert.equal((await DETAIL(new Request('http://localhost/api/feedback/missing', { headers: headers(admin) }))).status, 404);
    await executePlatformAction(publicUser(admin), 'mark-notification-read', { id: notification.id });
    assert.equal((await readNotificationSnapshot(publicUser(admin))).unreadCount, 0);
    const stored = await prisma.feedback.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(stored.userId, traveler.id);
    assert.equal(stored.sentiment, 'not_analyzed');
    assert.equal(await prisma.auditEvent.count({ where: { actorId: traveler.id, targetId: created.id, action: 'submit-feedback' } }), 1);
    assert.equal((await POST(new Request('http://localhost/api/feedback', { method: 'POST', headers: headers(other), body: JSON.stringify(body) }))).status, 400);
    assert.equal((await POST(new Request('http://localhost/api/feedback', { method: 'POST', headers: headers(admin), body: JSON.stringify(body) }))).status, 401);
    assert.equal((await GET(new Request('http://localhost/api/feedback', { headers: headers(traveler) }))).status, 401);
    assert.equal((await GET(new Request('http://localhost/api/feedback'))).status, 401);
    assert.equal((await ITINERARY(new Request(`http://localhost/api/feedback/${created.id}/itinerary`, { headers: headers(other) }))).status, 401);
    await assert.rejects(() => submitFeedback(publicUser(traveler), { ...body, itineraryId: 'missing' }), /not found/);
    const own = await OWN(new Request('http://localhost/api/feedback/itinerary/'+trip.id, { headers: headers(traveler) }));
    assert.equal((await own.json()).result.rating, 4);
    assert.equal((await OWN(new Request('http://localhost/api/feedback/itinerary/'+trip.id, { headers: headers(other) }))).status, 400);
    const updates = await Promise.all([2,5].map(rating => submitFeedback(publicUser(traveler), { ...body, rating })));
    assert.ok(updates.every(row => row.id === created.id));
    assert.equal(await prisma.feedback.count({ where: { userId: traveler.id, itineraryId: trip.id } }), 1);
    await submitFeedback(publicUser(traveler), body);
    assert.equal(await prisma.notification.count({ where: { userId: admin.id, href } }), 1);
    assert.ok((await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt);
    await executePlatformAction(publicUser(admin), 'mark-all-notifications-read', {});
    assert.equal(await prisma.feedback.count({ where: { id: created.id } }), 1);
    // Isolate pagination using a date far outside ordinary product data.
    await prisma.feedback.update({ where: { id: created.id }, data: { createdAt: new Date('2040-01-01T00:00:00Z') } });
    for (let index = 0; index < 11; index++) {
      const anotherTrip = await prisma.trip.create({ data: { userId: traveler.id, destination: 'Tokyo', budget: 1000, currency: 'JPY', startDate: new Date('2040-01-01'), endDate: new Date('2040-01-01'), travelers: 1, itinerary } });
      tripIds.push(anotherTrip.id);
      const row = await prisma.feedback.create({ data: { ...body, itineraryId: anotherTrip.id, userId: traveler.id, sentiment: 'not_analyzed', createdAt: new Date(`2040-01-01T23:59:${String(index).padStart(2, '0')}Z`) } });
      feedbackIds.push(row.id);
    }
    const query = 'rating=4&sentiment=not_analyzed&from=2040-01-01&to=2040-01-01';
    const list = async (suffix: string) => {
      const response = await GET(new Request(`http://localhost/api/feedback?${query}&${suffix}`, { headers: headers(admin) }));
      assert.equal(response.status, 200); return response.json();
    };
    const first = await list('page=1');
    const second = await list('page=2');
    assert.equal(first.total, 12); assert.equal(first.entries.length, 10); assert.equal(second.entries.length, 2);
    assert.equal(new Set([...first.entries, ...second.entries].map(item => item.id)).size, 12);
    assert.equal((await list('page=100')).page, 2);
    assert.equal((await GET(new Request('http://localhost/api/feedback?rating=4&sentiment=negative&from=2040-01-01&to=2040-01-01', { headers: headers(admin) })).then(response => response.json())).total, 0);
    assert.equal('passwordHash' in first.entries[0].user, false);
    const detail = await ITINERARY(new Request(`http://localhost/api/feedback/${created.id}/itinerary`, { headers: headers(admin) }));
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).itinerary.itinerary.days[0].activities[0].title, 'Museum visit');
    await prisma.trip.delete({ where: { id: trip.id } });
    await prisma.auditEvent.deleteMany({ where: { actorId: traveler.id } });
    await prisma.user.delete({ where: { id: traveler.id } });
    const retained = await prisma.feedback.findUniqueOrThrow({ where: { id: created.id } });
    assert.equal(retained.itineraryId, null); assert.equal(retained.userId, null);
    assert.equal((await ITINERARY(new Request(`http://localhost/api/feedback/${created.id}/itinerary`, { headers: headers(admin) }))).status, 404);
  } finally {
    if (feedbackIds.length) {
      await prisma.notification.deleteMany({ where: { href: { in: feedbackIds.map(id => '/admin/dashboard?tab=feedback&category=feedback&feedbackId=' + encodeURIComponent(id)) } } });
      await prisma.feedback.deleteMany({ where: { id: { in: feedbackIds } } });
    }
    if (ids.length) await prisma.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
    if (tripIds.length) await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});
