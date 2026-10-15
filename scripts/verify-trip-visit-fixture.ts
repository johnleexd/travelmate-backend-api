/** Isolated database fixture for live UI verification. Never targets real accounts. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
const file = new URL('../../travelmate-frontend-new/.trip-visits-live-fixture.json', import.meta.url);
try {
  if (process.argv[2] === 'cleanup') {
    const fixture = JSON.parse(await readFile(file, 'utf8')) as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: fixture.userId } });
    if (user && (!user.email.startsWith('trip-visits-browser-') || user.name !== 'Visited places browser fixture')) throw Error('Refusing to remove a non-fixture user.');
    const cleanup = await prisma.$transaction(async tx => {
      const others = async () => ({ accounts: await tx.user.count({ where: { id: { not: fixture.userId } } }),
        trips: await tx.trip.count({ where: { userId: { not: fixture.userId } } }),
        visits: await tx.visitedPlace.count({ where: { userId: { not: fixture.userId } } }) });
      const before = await others();
      const removed = { accounts: user ? 1 : 0, trips: await tx.trip.count({ where: { userId: fixture.userId } }), visits: await tx.visitedPlace.count({ where: { userId: fixture.userId } }) };
      await tx.auditEvent.deleteMany({ where: { actorId: fixture.userId } });
      await tx.user.deleteMany({ where: { id: fixture.userId } });
      const after = await others();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Unrelated record counts changed; rolling back cleanup.');
      return { removed, unrelatedCountsUnchanged: true };
    }, { isolationLevel: 'Serializable', timeout: 20000 });
    await unlink(file); console.log(JSON.stringify({ ...cleanup, temporarySessionRemoved: true }));
  } else if (process.argv[2] === 'seed') {
    const user = await prisma.user.create({ data: { name: 'Visited places browser fixture', email: `trip-visits-browser-${randomUUID()}@example.test`, role: 'traveler', emailVerified: true } });
    // Write the cleanup identity immediately, even if creating the plan fails.
    const fixture = { userId: user.id, token: createSessionToken(user.id, 'traveler'), tripId: '', destination: 'Paris, France' };
    await writeFile(file, JSON.stringify(fixture));
    const places = [{ placeId: 'Q243', name: 'Eiffel Tower', latitude: 48.8584, longitude: 2.2945 }, { placeId: 'Q19675', name: 'Louvre Museum', latitude: 48.8606, longitude: 2.3376 }, { placeId: 'Q2981', name: 'Notre-Dame de Paris', latitude: 48.853, longitude: 2.3499 }];
    const activities = places.map((place, index) => ({ id: `fixture-place-${index}`, title: 'Visit ' + place.name, category: 'activity', icon: 'map', description: 'Controlled saved-place fixture for visited recording.', time: ['09:00', '11:00', '14:00'][index], durationMinutes: 60, estimatedCost: 0,
      place: { ...place, provider: 'wikidata', city: 'Paris', country: 'France', countryCode: 'FR', address: 'Paris, France', sourceUrl: 'https://www.wikidata.org/wiki/' + place.placeId, fetchedAt: new Date().toISOString(), openingHours: 'Not available' } }));
    const plan = { destination: fixture.destination, currency: 'EUR', totalBudget: 1000, travelers: 1, partyType: 'solo', source: 'catalog',
      days: [{ day: 1, date: '2040-01-01', theme: 'Fixture saved places', imageUrl: '', totalCost: 0, activities: [...activities.slice(0, 2), { title: 'Daily meals allowance', time: 'Daily allowance', description: 'Budget only', category: 'food', icon: 'food', estimatedCost: 0 }] },
        { day: 2, date: '2040-01-02', theme: 'Another saved day', imageUrl: '', totalCost: 0, activities: [activities[2], activities[0]] }],
      budgetSummary: { total: 1000, accommodation: 0, food: 0, activities: 0, transport: 0, reserve: 1000, dailyAverage: 0, plannedSpend: 0 } };
    const trip = await prisma.trip.create({ data: { userId: user.id, destination: fixture.destination, destinationCity: 'Paris', destinationCountry: 'France', destinationCountryCode: 'FR', latitude: 48.8534, longitude: 2.3488, budget: 1000, currency: 'EUR', travelers: 1, startDate: new Date('2040-01-01'), endDate: new Date('2040-01-02'), itinerary: plan } });
    fixture.tripId = trip.id; await writeFile(file, JSON.stringify(fixture)); console.log('Isolated live UI fixture ready. Session credentials were not printed.');
  } else throw Error('Choose seed or cleanup.');
} finally { await prisma.$disconnect(); }
