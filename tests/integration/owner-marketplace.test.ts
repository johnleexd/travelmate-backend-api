import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { publicUser } from '../../src/schemas/domain.ts';
import { executePlatformAction } from '../../src/services/platform/platform-service.ts';

test('owner marketplace connects requests, availability, payments, reviews, and notifications', async () => {
  const marker = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const owner = await prisma.user.create({ data: { name: 'Marketplace Test Owner', email: `owner-${marker}@example.test`, role: 'owner', emailVerified: true, profileStatus: 'verified' } });
  const traveler = await prisma.user.create({ data: { name: 'Marketplace Test Traveler', email: `traveler-${marker}@example.test`, role: 'traveler', emailVerified: true, profileStatus: 'verified' } });
  try {
    const listing = await prisma.listing.create({ data: { ownerId: owner.id, name: 'Marketplace Test Stay', category: 'stay', price: 1200, capacity: 4, available: 4, status: 'approved', municipality: 'Cordova', imageUrls: [] } });
    const ownerUser = publicUser(owner);
    const travelerUser = publicUser(traveler);

    await executePlatformAction(ownerUser, 'block-date', { listingId: listing.id, date: '2030-03-10', reason: 'Maintenance' });
    await assert.rejects(() => executePlatformAction(travelerUser, 'book', { listingId: listing.id, guests: 2, nights: 2, checkIn: '2030-03-10', checkOut: '2030-03-12' }), /blocked/);
    await executePlatformAction(ownerUser, 'unblock-date', { listingId: listing.id, date: '2030-03-10' });
    await executePlatformAction(ownerUser, 'create-promotion', { listingId: listing.id, name: 'Test season', discountPct: 25, startDate: '2030-03-01', endDate: '2030-03-31' });

    const requested = await executePlatformAction(travelerUser, 'book', { listingId: listing.id, guests: 2, nights: 2, checkIn: '2030-03-10', checkOut: '2030-03-12' }) as { id: string; status: string; paymentStatus: string; amount: number };
    assert.equal(requested.status, 'pending');
    assert.equal(requested.paymentStatus, 'PENDING');
    assert.equal(requested.amount, 1800);

    const confirmed = await executePlatformAction(ownerUser, 'owner-request-decision', { id: requested.id, decision: 'approve' }) as { status: string; paymentStatus: string };
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.paymentStatus, 'PAID_HELD');
    assert.equal((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).available, 2);

    await executePlatformAction(ownerUser, 'release-payment', { id: requested.id });
    const review = await executePlatformAction(travelerUser, 'submit-review', { bookingId: requested.id, rating: 5, comment: 'Clear and accurate listing.' }) as { rating: number };
    assert.equal(review.rating, 5);
    assert.ok(await prisma.notification.count({ where: { userId: { in: [owner.id, traveler.id] } } }) >= 3);
    assert.ok(await prisma.paymentTransaction.count({ where: { bookingId: requested.id } }) >= 2);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: [traveler.id, owner.id] } } });
    await prisma.user.deleteMany({ where: { id: traveler.id } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
  }
});
