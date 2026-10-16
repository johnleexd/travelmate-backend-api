import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.ts';
import type { Trip } from '../src/generated/prisma/client.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { createVersionSnapshot } from '../src/services/itinerary/version-snapshot.ts';
import { executePlatformAction } from '../src/services/platform/platform-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';
import type { ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { reusableStoredActivityPhoto } from '../src/services/itinerary/activity-photo-fallback.ts';
import { signGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { buildGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { retryIncompleteDays } from '../src/services/itinerary/incomplete-day-retry.ts';
import type { GroundedPlace } from '../src/services/itinerary/grounded-places.ts';

const user: PublicUser = { id: 'snapshot-owner', role: 'traveler', name: 'Test', email: 'test@example.test', emailVerified: true, profileStatus: 'unverified', accountStatus: 'active', trustScore: 50 };
const context = { days: 1, currency: 'PHP' as const, budget: 1000, travelers: 1, partyType: 'solo' as const, destination: 'Tokyo', startDate: '2040-01-01' };
function plan() {
  return { destination: 'Tokyo', totalBudget: 1000, currency: 'PHP', partyType: 'solo', travelers: 1,
    days: [{ day: 1, date: '2040-01-01', theme: 'Museum day', imageUrl: '', totalCost: 100, activities: [{ time: '09:00', title: 'Museum', description: 'Visit the museum', estimatedCost: 100, category: 'activity', icon: 'map', priceEvidence: { status: 'estimate', source: 'user-entered', basis: 'Explicit party total', currency: 'PHP', unit: 'group', unitAmount: 100, quantity: 1, participants: 1, needsConfirmation: true, fetchedAt: '2040-01-01T00:00:00Z' } }] }],
    budgetSummary: { accommodation: 0, food: 0, activities: 0, transport: 0, reserve: 0, dailyAverage: 1, total: 1, plannedSpend: 0, remainingBudget: 1000 },
    costSharing: { partyType: 'solo', travelers: 1, groupBudget: 1, plannedGroupSpend: 0, budgetShares: [1], plannedSpendShares: [0], accommodationShares: [0], reserveShares: [1000] },
  };
}
function trip(): Trip {
  return { id: 'trip', userId: user.id, destination: 'Tokyo', destinationCity: 'Tokyo', destinationRegion: null,
    destinationCountry: 'Japan', destinationCountryCode: 'JP', latitude: 35.6762, longitude: 139.6503,
    budget: 1000, currency: 'PHP', startDate: new Date('2040-01-01'), endDate: new Date('2040-01-01'),
    travelers: 1, partyType: 'solo', interests: ['culture'], itinerary: parseSavedItinerary(plan(), context), weather: null,
    status: 'active', archivedAt: null, createdAt: new Date(), updatedAt: new Date() } as unknown as Trip;
}
function transaction(t: TestContext, current: Trip, snapshot: unknown, accessible = true) {
  let updates = 0;
  const tx = {
    trip: {
      findFirst: async (query: { where: { userId: string } }) => { assert.equal(query.where.userId, user.id); return accessible ? current : null; },
      update: async ({ data }: { data: Record<string, unknown> }) => { updates++; Object.assign(current, data); return current; },
    },
    itineraryVersion: {
      findFirst: async ({ where }: { where: { tripId: string } }) => { assert.equal(where.tripId, current.id); return { id: 'version', itinerary: snapshot, weather: null }; },
      aggregate: async () => ({ _max: { version: 2 } }), create: async ({ data }: { data: unknown }) => data,
    },
    auditEvent: { create: async () => ({}) }, $queryRaw: async () => [],
  };
  const previous = prisma.$transaction;
  Reflect.set(prisma, '$transaction', async (callback: (client: unknown) => unknown) => callback(tx));
  t.after(() => Reflect.set(prisma, '$transaction', previous));
  return () => updates;
}
after(() => prisma.$disconnect());

test('saving a retried itinerary retains new verified places, edited notes and protected completed activities', async t => {
  const anchor = { city: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.68, longitude: 139.76 };
  const catalog: GroundedPlace[] = Array.from({ length: 5 }, (_, index) => ({ provider: 'wikidata', placeId: `Q${100 + index}`, name: `Fixture museum ${index}`, description: 'museum', ...anchor, latitude: anchor.latitude + index / 100000, sourceUrl: `https://www.wikidata.org/wiki/Q${100 + index}`, fetchedAt: '2040-01-01T00:00:00Z', openingHours: 'Opening hours need confirmation', address: 'Unconfirmed' }));
  const original = buildGroundedPlan({ destination: 'Tokyo', anchor, startingLocation: '', startDate: '2040-01-01', endDate: '2040-01-02', budget: 1000, currency: 'PHP', travelers: 1, partyType: 'solo', rooms: 1, places: catalog.slice(0, 1), placeDataStatus: 'live', source: 'catalog', transportation: '', schedule: completeGroundedSchedule(anchor, catalog.slice(0, 1), [], '2040-01-01', 2, 1, 'balanced') });
  original.days[0].activities[0].status = 'completed';
  const current = { ...trip(), endDate: new Date('2040-01-02'), itinerary: original } as unknown as Trip;
  const updates = transaction(t, current, null);
  const retried = retryIncompleteDays(original, [1], { places: catalog, status: 'live' }).itinerary;
  assert.ok(retried.days[1].activities.some(item => item.place));
  const edited = structuredClone(retried); edited.days[1].activities.find(item => item.place)!.description = 'My additional notes';
  const response = await executePlatformAction(user, 'update-trip-itinerary', { id: current.id, itinerary: edited, providerBase: retried }) as { itinerary: ItineraryResponse };
  assert.equal(updates(), 1);
  assert.equal(response.itinerary.days[0].activities[0].status, 'completed');
  assert.equal(response.itinerary.days[1].activities.find(item => item.place)!.description, 'My additional notes');
  assert.deepEqual(response.itinerary.days[1].activities.flatMap(item => item.place ? [item.place.placeId] : []), retried.days[1].activities.flatMap(item => item.place ? [item.place.placeId] : []));
  assert.doesNotThrow(() => parseSavedItinerary(response.itinerary, { ...context, days: 2 }));
});

test('manual activity save persists Travel style without replacing historical trip interests', async t => {
  const current = trip();
  const updates = transaction(t, current, null);
  const submitted = plan();
  submitted.days[0].activities[0].description = 'My updated visit notes';
  const planningPreferences = { travelStyle: 'family-friendly', accommodation: 'resort', transportation: 'walking', activities: ['museum'], interests: ['Museum', 'nature', 'NATURE'] };
  const response = await executePlatformAction(user, 'update-trip-itinerary', { id: current.id, itinerary: submitted, planningPreferences }) as { itinerary: ItineraryResponse; interests: string[] };
  assert.equal(updates(), 1);
  assert.equal(response.itinerary.preferences?.travelStyle, 'family-friendly');
  assert.deepEqual(response.interests, ['culture']);
  assert.deepEqual(response.itinerary.preferences?.activities, ['museum']);
  assert.equal(response.itinerary.days[0].activities[0].description, 'My updated visit notes');
});

test('style and transport edits preserve exact historical lists in full and manual saves', async t => {
  const historical = { travelStyle: 'luxury', accommodation: 'resort', transportation: 'walking', interests: ['Food', 'food', 'Nature'], activities: ['Snorkeling', 'SIGHTSEEING'] };
  const current = { ...trip(), interests: ['Original', 'ORIGINAL'], itinerary: { ...plan(), preferences: historical } } as unknown as Trip;
  const updates = transaction(t, current, null);
  const incoming = { ...plan(), preferences: { travelStyle: 'comfort', accommodation: 'resort', transportation: 'taxi', interests: [], activities: [] } };
  for (const interests of [undefined, [], '', null]) {
    const result = await executePlatformAction(user, 'update-trip', { id: current.id, destination: 'Tokyo', budget: 1000, currency: 'PHP', startDate: '2040-01-01', endDate: '2040-01-01', travelers: 1, partyType: 'solo', interests, itinerary: incoming }) as { itinerary: ItineraryResponse; interests: string[] };
    assert.deepEqual(result.interests, ['Original', 'ORIGINAL']);
    assert.deepEqual(result.itinerary.preferences?.interests, historical.interests);
    assert.deepEqual(result.itinerary.preferences?.activities, historical.activities);
    assert.equal(result.itinerary.preferences?.travelStyle, 'comfort');
    assert.equal(result.itinerary.preferences?.transportation, 'walking');
    assert.deepEqual(result.itinerary.days, incoming.days);
  }
  const result = await executePlatformAction(user, 'update-trip-itinerary', { id: current.id, itinerary: incoming, planningPreferences: { travelStyle: 'family-friendly', transportation: 'walking' } }) as { itinerary: ItineraryResponse; interests: string[] };
  assert.equal(updates(), 5);
  assert.equal(result.itinerary.preferences?.travelStyle, 'family-friendly');
  assert.deepEqual(result.interests, ['Original', 'ORIGINAL']);
  assert.deepEqual(result.itinerary.preferences?.interests, historical.interests);
  assert.deepEqual(result.itinerary.preferences?.activities, historical.activities);
  const snapshot = createVersionSnapshot(current);
  assert.deepEqual(snapshot.context.interests, ['Original', 'ORIGINAL']);
  assert.deepEqual((snapshot.itinerary as unknown as ItineraryResponse).preferences?.activities, historical.activities);
});

test('the reported Tokyo photos retain their URLs and original rights metadata through validation, manual save, API serialization and reopening', async t => {
  const recorded: ItineraryResponse = JSON.parse(readFileSync(new URL('./fixtures/tokyo-photo-plan.json', import.meta.url), 'utf8'));
  assert.ok(recorded.days[0].activities.filter(activity => activity.imageUrl).every(reusableStoredActivityPhoto));
  const photoContext = { ...context, destination: 'Tokyo, Japan', currency: 'JPY' as const, budget: 30000, startDate: recorded.days[0].date };
  const original = parseSavedItinerary({ ...recorded, groundingProof: signGroundedPlan(recorded) }, photoContext);
  const photoFields = (itinerary: ItineraryResponse) => itinerary.days[0].activities.filter(activity => activity.imageUrl).map(({ imageUrl, imageAttribution }) => ({ imageUrl, imageAttribution }));
  const expected = photoFields(recorded);
  assert.deepEqual(photoFields(original), expected);
  const current = { ...trip(), destination: photoContext.destination, currency: photoContext.currency, budget: photoContext.budget, startDate: new Date(photoContext.startDate), endDate: new Date(photoContext.startDate), itinerary: JSON.parse(JSON.stringify(original)) } as Trip;
  transaction(t, current, null);
  const submitted = structuredClone(original); submitted.days[0].activities[0].time = '09:15';
  const response = await executePlatformAction(user, 'update-trip-itinerary', { id: current.id, itinerary: submitted });
  const serialized = JSON.parse(JSON.stringify(response)) as { itinerary: ItineraryResponse; startDate: string };
  assert.equal(serialized.startDate, photoContext.startDate);
  assert.equal(serialized.itinerary.days[0].activities[0].time, '09:15');
  assert.deepEqual(photoFields(serialized.itinerary), expected);
  assert.deepEqual(photoFields(current.itinerary as unknown as ItineraryResponse), expected);
  const reopened = parseSavedItinerary(JSON.parse(JSON.stringify(current.itinerary)), photoContext);
  assert.deepEqual(photoFields(reopened), expected);
  assert.ok(reopened.days[0].activities.filter(activity => activity.imageUrl).every(reusableStoredActivityPhoto));
  assert.equal(reopened.days[0].imageUrl, original.days[0].imageUrl);
  assert.deepEqual(reopened.days[0].imageAttribution, original.days[0].imageAttribution);
});

test('save validation replaces contradictory summaries and shares with exact item-based totals', () => {
  const result = parseSavedItinerary(plan(), context);
  assert.equal(result.budgetSummary.total, 1000);
  assert.equal(result.budgetSummary.plannedSpend, 100);
  assert.equal(result.budgetSummary.remainingBudget, 900);
  assert.equal(result.budgetSummary.shortfall, 0);
  assert.equal(result.costSharing!.groupBudget, 1000);
  assert.deepEqual(result.costSharing!.plannedSpendShares, [100]);
  assert.deepEqual(result.costSharing!.reserveShares, [900]);
});

test('selected travel costs are included once and fractional shares retain every currency unit', () => {
  const input = { ...plan(), totalBudget: 1000.01, currency: 'USD', partyType: 'friends', travelers: 3, costSharing: undefined,
    selectedTravelCosts: { activities: [], total: 20, flight: { id: 'flight', name: 'Flight', total: 20, currency: 'USD', fetchedAt: '2040-01-01T00:00:00.000Z' } } };
  input.days[0].activities[0].priceEvidence.currency='USD';input.days[0].activities[0].priceEvidence.participants=3;
  const result = parseSavedItinerary(input, { ...context, budget: 1000.01, currency: 'USD', partyType: 'friends', travelers: 3 });
  assert.equal(result.budgetSummary.plannedSpend, 120);
  assert.equal(result.budgetSummary.remainingBudget, 880.01);
  assert.equal(Math.round(result.costSharing!.budgetShares.reduce((sum, value) => sum + value, 0) * 100), 100001);
  assert.deepEqual(result.costSharing!.plannedSpendShares, [40, 40, 40]);
});

test('saved costs reject destination contradictions and fractional zero-decimal spending', () => {
  assert.throws(() => parseSavedItinerary(plan(), { ...context, destination: 'Paris' }), /destination must match/);
  const input = plan(); input.currency = 'JPY'; input.days[0].totalCost = 100.01; input.days[0].activities[0].estimatedCost = 100.01;
  assert.throws(() => parseSavedItinerary(input, { ...context, currency: 'JPY' }), /currency precision/);
});

test('version restore atomically restores original destination, dates, currency, budget and party', async t => {
  const original = trip();
  const snapshot = createVersionSnapshot(original);
  const current = { ...original, destination: 'Paris', destinationCountry: 'France', destinationCountryCode: 'FR',
    currency: 'USD', budget: 2000, travelers: 3, partyType: 'friends', startDate: new Date('2041-02-01'), endDate: new Date('2041-02-03') } as unknown as Trip;
  const updates = transaction(t, current, snapshot);
  const result = await executePlatformAction(user, 'restore-itinerary-version', { id: 'trip', versionId: 'version' }) as Record<string, unknown>;
  assert.equal(updates(), 1);
  for (const field of ['destination', 'destinationCountry', 'currency', 'budget', 'travelers', 'partyType']) assert.deepEqual(result[field], Reflect.get(original, field));
  assert.equal(result.startDate, '2040-01-01'); assert.equal(result.endDate, '2040-01-01');
  assert.deepEqual(result.interests, ['culture']);
  assert.equal((result.itinerary as { destination: string }).destination, result.destination);
});

test('legacy snapshots recover recorded details and clear unavailable geographic context', async t => {
  const original = trip();
  const current = { ...original, destination: 'Paris', budget: 2000, destinationCountry: 'France' } as unknown as Trip;
  transaction(t, current, original.itinerary);
  const result = await executePlatformAction(user, 'restore-itinerary-version', { id: 'trip', versionId: 'version' }) as Record<string, unknown>;
  assert.equal(result.destination, 'Tokyo'); assert.equal(result.budget, 1000);
  assert.equal(result.destinationCountry, null); assert.deepEqual(result.interests, []);
  assert.equal(result.legacyContextRecovered, true);
});

test('a snapshot with contradictory context cannot modify the trip', async t => {
  const current = trip(); const snapshot = createVersionSnapshot(current); snapshot.context.destination = 'Paris';
  const updates = transaction(t, current, snapshot);
  await assert.rejects(executePlatformAction(user, 'restore-itinerary-version', { id: 'trip', versionId: 'version' }), /destination must match/);
  assert.equal(updates(), 0);
});

test('a legacy version without recorded party details fails safely rather than borrowing a changed party', async t => {
  const current = trip();
  const legacy = { ...plan(), partyType: undefined, travelers: undefined, costSharing: undefined };
  const updates = transaction(t, current, legacy);
  await assert.rejects(executePlatformAction(user, 'restore-itinerary-version', { id: 'trip', versionId: 'version' }), /did not record its party details/);
  assert.equal(updates(), 0);
});

test('restoration checks ownership before reading a version or writing', async t => {
  const current = trip(); const updates = transaction(t, current, createVersionSnapshot(current), false);
  await assert.rejects(executePlatformAction(user, 'restore-itinerary-version', { id: 'trip', versionId: 'version' }), /not found/);
  assert.equal(updates(), 0);
});

test('saving a mapped stay preserves its stable property identity in the trip and version transaction', async t => {
  const findUnique = prisma.trip.findUnique; Reflect.set(prisma.trip, 'findUnique', async () => null);
  t.after(() => Reflect.set(prisma.trip, 'findUnique', findUnique));
  const plannedAccommodation = { source: 'openstreetmap', sourceId: 'osm:way:987654', name: 'Mapped Tokyo Guesthouse', address: 'Tokyo, Japan', type: 'Guesthouse' };
  const interests = Array.from({ length: 60 }, (_, index) => `Interest ${index + 1}`);
  const preferences = { travelStyle: 'comfort', accommodation: 'resort', transportation: 'walking', activities: [], interests };
  const itinerary = { ...plan(), plannedAccommodation, preferences };
  let persisted: Record<string, unknown> | undefined;
  let version: Record<string, unknown> | undefined;
  const tx = {
    trip: { create: async ({ data }: { data: Record<string, unknown> }) => {
      assert.equal(data.userId, user.id);
      persisted = data;
      return { ...trip(), ...data };
    } },
    itineraryVersion: {
      aggregate: async () => ({ _max: { version: null } }),
      create: async ({ data }: { data: Record<string, unknown> }) => { version = data; return data; },
    },
    auditEvent: { create: async () => ({}) }, $queryRaw: async () => [],
  };
  const previous = prisma.$transaction;
  Reflect.set(prisma, '$transaction', async (callback: (client: unknown) => unknown) => callback(tx));
  t.after(() => Reflect.set(prisma, '$transaction', previous));
  const result = await executePlatformAction(user, 'save-trip', {
    destination: 'Tokyo', budget: 1000, currency: 'PHP', travelers: 1, partyType: 'solo',
    startDate: '2040-01-01', endDate: '2040-01-01', interests: [...interests, 'INTEREST 1'], itinerary,
  }) as { itinerary: { plannedAccommodation: unknown } };
  assert.deepEqual(result.itinerary.plannedAccommodation, plannedAccommodation);
  assert.deepEqual((persisted!.itinerary as { plannedAccommodation: unknown }).plannedAccommodation, plannedAccommodation);
  const snapshot = version!.itinerary as { itinerary: { plannedAccommodation: unknown } };
  assert.deepEqual(snapshot.itinerary.plannedAccommodation, plannedAccommodation);
  assert.deepEqual(persisted!.interests, interests);
  assert.deepEqual((persisted!.itinerary as { preferences: unknown }).preferences, preferences);
  assert.deepEqual((snapshot.itinerary as { preferences: unknown }).preferences, preferences);
  assert.equal(version!.kind, 'saved');
  assert.equal(version!.version, 1);
});

test('a provider quote is saved with exact identity, occupancy, price and photo references in both trip and version', async t => {
  const findUnique = prisma.trip.findUnique; Reflect.set(prisma.trip, 'findUnique', async () => null);
  t.after(() => Reflect.set(prisma.trip, 'findUnique', findUnique));
  const quote = { provider: 'expedia-rapid', propertyId: '123', roomId: 'room', offerId: 'rate', roomType: 'Single room', checkInDate: '2040-01-01', checkOutDate: '2040-01-02', occupancy: [{ adults: 1, childAges: [] }], currency: 'PHP', total: 200, nightlyAverage: 200, taxesAndFeesIncluded: true, payableAtProperty: [{ amount: 20, currency: 'PHP' }], priceBreakdown: [], checkedAt: new Date().toISOString(), isLive: true, photoReferences: ['123:photo-reference'] };
  const accommodation = { listingId: 'rapid:123', offerId: 'rate', name: 'Official Hotel', address: 'Tokyo', nightlyRate: 200, nights: 1, total: 200, quotedTotal: 200, rooms: 1, currency: 'PHP', source: 'expedia-rapid', isLive: true, providerQuote: quote };
  const itinerary = { ...plan(), accommodation, days: plan().days.map(day => ({ ...day, totalCost: 300 })) };
  let persisted: Record<string, unknown> | undefined, version: Record<string, unknown> | undefined;
  const tx = {
    trip: { create: async ({ data }: { data: Record<string, unknown> }) => { persisted = data; assert.equal(data.userId, user.id); return { ...trip(), ...data }; } },
    itineraryVersion: { aggregate: async () => ({ _max: { version: null } }), create: async ({ data }: { data: Record<string, unknown> }) => { version = data; return data; } },
    auditEvent: { create: async () => ({}) }, $queryRaw: async () => [],
  };
  const previous = prisma.$transaction;
  Reflect.set(prisma, '$transaction', async (callback: (client: unknown) => unknown) => callback(tx));
  t.after(() => Reflect.set(prisma, '$transaction', previous));
  await executePlatformAction(user, 'save-trip', { destination: 'Tokyo', budget: 1000, currency: 'PHP', travelers: 1, partyType: 'solo', startDate: '2040-01-01', endDate: '2040-01-01', interests: ['culture'], itinerary });
  assert.deepEqual((persisted!.itinerary as { accommodation: unknown }).accommodation, accommodation);
  const snapshot = version!.itinerary as { itinerary: { accommodation: unknown } };
  assert.deepEqual(snapshot.itinerary.accommodation, accommodation);
  assert.equal((persisted!.itinerary as { budgetSummary: { accommodationActual: number } }).budgetSummary.accommodationActual, 200);
  for (const field of [{ propertyId: '456' }, { total: 201 }, { checkOutDate: '2040-01-03' }, { occupancy: [{ adults: 2, childAges: [] }] }]) {
    assert.throws(() => parseSavedItinerary({ ...itinerary, accommodation: { ...accommodation, providerQuote: { ...quote, ...field } } }, context), /quote must match/);
  }
});
