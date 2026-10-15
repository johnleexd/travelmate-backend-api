import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroundedPlan, calculateExpense, refreshGroundedTotals, verifyGroundedPlan, signGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { createOfferToken, verifyOfferToken } from '../src/utils/offer-token.ts';
import { entityBelongsToDestination, retrieveGroundedPlaces, validateDestinationAnchor, openingDetails, type GroundedPlace } from '../src/services/itinerary/grounded-places.ts';
import { validateGroundedSchedule, generateGroundedSchedule, dateAt } from '../src/services/ai/grounded-schedule.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { createTravelSelectionToken, verifyTravelSelectionToken } from '../src/utils/travel-selection-token.ts';
import type { DestinationAnchor } from '../src/services/itinerary/grounding-schema.ts';
import type { CurrencyCode } from '../src/schemas/domain.ts';

const start = '2040-01-25';
const anchors: DestinationAnchor[] = [
  { city: 'Tokyo', country: 'Japan', countryCode: 'JP', latitude: 35.6895, longitude: 139.6917 },
  { city: 'Paris', country: 'France', countryCode: 'FR', latitude: 48.8534, longitude: 2.3488 },
  { city: 'Bangkok', country: 'Thailand', countryCode: 'TH', latitude: 13.75, longitude: 100.5167 },
  { city: 'New York City', country: 'United States', countryCode: 'US', latitude: 40.7143, longitude: -74.006 },
];
function place(anchor: DestinationAnchor, index = 0): GroundedPlace {
  return { provider: 'wikidata', placeId: `Q${200 + index}`, name: `${anchor.city} test museum ${index}`, city: anchor.city, country: anchor.country, countryCode: anchor.countryCode,
    latitude: anchor.latitude + index * 0.0001, longitude: anchor.longitude, fetchedAt: '2026-10-06T00:00:00.000Z', sourceUrl: `https://www.wikidata.org/wiki/Q${200 + index}`, openingHours: 'Not available; confirm with venue', address: 'Not available', description: `Test museum in ${anchor.city}` };
}
function plan(anchor = anchors[1], travelers = 3, days = 3, currency: CurrencyCode = 'EUR') {
  const places = Array.from({ length: days }, (_, i) => place(anchor, i));
  return buildGroundedPlan({ destination: `${anchor.city}, ${anchor.country}`, anchor, startingLocation: 'Toronto, Canada', startDate: start, endDate: dateAt(start, days - 1), budget: 100000, currency,
    travelers, partyType: travelers === 1 ? 'solo' : travelers === 2 ? 'couple' : 'friends', rooms: Math.ceil(travelers / 2), places, placeDataStatus: 'live', source: 'openai', transportation: 'Taxi',
    schedule: places.map((item, i) => ({ day: i + 1, date: dateAt(start, i), theme: 'Malicious unsupported place name', visits: [{ placeId: item.placeId, startMinutes: 600, durationMinutes: 60, participants: Math.min(2, travelers) }] })) });
}

for (const [index, anchor] of anchors.entries()) {
  for (const [travelers, days] of [[1, 1], [2, 3], [5, 14], [3, 31]]) {
    test(`${anchor.countryCode}: ${travelers} travelers and ${days} days reconcile category totals, room-night and participant formulas`, () => {
      const currency: CurrencyCode = index === 0 ? 'JPY' : index === 1 ? 'EUR' : index === 2 ? 'THB' : 'USD';
      const result = plan(anchor, travelers, days, currency);
      const evidence = result.grounding!;
      const scale = currency === 'JPY' ? 1 : 100;
      assert.equal(Math.round(Object.values(evidence.categories).reduce((sum, amount) => sum + amount, 0) * scale), Math.round(evidence.total * scale));
      assert.equal(evidence.categories.food, calculateExpense(evidence.foodDailyPerPerson, days, travelers, 'daily-per-person', currency));
      assert.equal(evidence.categories.accommodation, calculateExpense(evidence.accommodation.unitAmount, evidence.rooms * evidence.nights, travelers, 'per-room-night', currency));
      assert.equal(Math.round(evidence.categories.transportation * scale), Math.round(result.days.reduce((sum, day) => sum + day.rideFare!, 0) * scale));
      assert.equal(result.days[0].activities[0].estimatedCost, calculateExpense(result.days[0].activities[0].unitCost!, 1, Math.min(2, travelers), 'per-person', currency));
      assert.equal(result.days.at(-1)?.date, dateAt(start, days - 1));
      assert.equal(result.days[0].activities[0].place?.countryCode, anchor.countryCode);
      assert.ok(!result.days[0].theme.includes('Malicious'));
      assert.equal(result.days[0].imageUrl, '');
      assert.equal(evidence.budgetStatus, 'needs-confirmation');
      assert.equal(evidence.verifiedAmount, 0);
      assert.equal(verifyGroundedPlan(result), true);
      assert.equal(parseSavedItinerary(result, { budget: result.totalBudget, currency, travelers, partyType: result.partyType!, startDate: start, destination: result.destination, days }).grounding?.total, evidence.total);
    });
  }
}

test('shared fares are counted once; per-person fares use participating travelers and currency precision', () => {
  assert.equal(calculateExpense(120, 2, 5, 'shared-fare', 'USD'), 240);
  assert.equal(calculateExpense(120, 2, 5, 'per-person', 'USD'), 1200);
  assert.equal(calculateExpense(39.99, 4, 3, 'per-room-night', 'USD'), 159.96);
  assert.throws(() => calculateExpense(10, -1, 1, 'group', 'USD'), /invalid/);
});

test('budgets too small retain supported prices and report a shortfall instead of changing prices to fit', () => {
  const result = plan();
  result.days[0].activities[0].estimatedCost = 20;
  result.days[0].activities[0].unitCost = 10;
  result.days[0].activities[0].priceEvidence = { ...result.days[0].activities[0].priceEvidence!, status: 'estimate', source: 'user-entered', unitAmount: 10 };
  const priced = refreshGroundedTotals(result);
  const next = refreshGroundedTotals({ ...priced, totalBudget: 1 });
  assert.equal(next.grounding?.budgetStatus, 'exceeds-budget');
  assert.equal(next.grounding?.total, priced.grounding?.total);
  assert.equal(next.days[0].activities[0].unitCost, result.days[0].activities[0].unitCost);
});

test('signed quote provenance survives JSONB key reordering but rejects forged amounts, sources and places', () => {
  const result = plan();
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
  assert.equal(verifyGroundedPlan(reorder(result)), true);
  for (const modify of [
    (value: typeof result) => { value.days[0].activities[0].estimatedCost += 1; },
    (value: typeof result) => { value.grounding!.accommodation.status = 'provider-quote'; },
    (value: typeof result) => { value.days[0].activities[0].place!.countryCode = 'JP'; },
  ]) {
    const forged = structuredClone(result); modify(forged);
    assert.equal(verifyGroundedPlan(forged), false);
    assert.throws(() => parseSavedItinerary(forged, { budget: result.totalBudget, currency: 'EUR', travelers: 3, partyType: 'friends', startDate: start, destination: result.destination, days: 3 }), /evidence or prices were changed/);
  }
});

test('manual edits downgrade claimed prices, discard unrelated photos/places and recalculate fees only once', () => {
  const original = plan(); original.grounding!.additionalFees = 100;
  const existing = refreshGroundedTotals(original);
  const edited = structuredClone(existing);
  edited.days[0].activities[0].title = 'User venue'; edited.days[0].activities[0].estimatedCost = 42;
  const result = applyManualItineraryChanges(existing, edited, 3, existing.totalBudget, 3, 'EUR') as any;
  assert.equal(result.days[0].activities[0].priceEvidence.source, 'user-entered');
  assert.equal(result.days[0].activities[0].place, undefined);
  assert.equal(result.days[0].activities[0].imageUrl, undefined);
  assert.equal(result.grounding.categories.fees, 100);
  assert.equal(refreshGroundedTotals(result).grounding?.total, result.grounding.total);
  assert.equal(verifyGroundedPlan(result), true);
  assert.equal(parseSavedItinerary(result, { budget: existing.totalBudget, currency: 'EUR', travelers: 3, partyType: 'friends', startDate: start, destination: existing.destination, days: 3 }).grounding?.total, result.grounding.total);
});

test('country and administrative city membership are required even for a nearby similarly named place', () => {
  const claim = (value: any) => [{ mainsnak: { datavalue: { value } } }];
  const entities = { Q200: { claims: { P131: claim({ id: 'Q1' }), P17: claim({ id: 'Q2' }) } }, Q1: { labels: { en: { value: 'Paris' } } }, Q2: { claims: { P297: claim('FR') } } };
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), true);
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[0]), false);
  entities.Q1.labels.en.value = 'Lyon';
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), false);
});

test('destination identity rejects missing inputs, mismatched coordinates and a changed country', async () => {
  const paris = searchDestinationIndex('Paris, France').find(place => place.name === 'Paris')!;
  const anchor = { ...anchors[1], latitude: paris.latitude, longitude: paris.longitude };
  assert.deepEqual(await validateDestinationAnchor(paris.label, anchor, anchor.latitude, anchor.longitude), anchor);
  await assert.rejects(validateDestinationAnchor('Paris', undefined, 0, 0), /Select a destination/);
  await assert.rejects(validateDestinationAnchor('Paris', anchor, 10, 10), /do not match/);
  await assert.rejects(validateDestinationAnchor('Paris', { ...anchor, countryCode: 'JP' }, anchor.latitude, anchor.longitude), /could not be validated/);
});

test('present-day membership ignores historical countries and administrative parents without weakening current country checks', () => {
  const claim = (id: string, extra = {}) => ({ mainsnak: { datavalue: { value: { id } } }, ...extra });
  const date = (time: string) => [{ datavalue: { value: { time } } }];
  const entities: any = {
    Q200: { claims: { P131: [claim('Q1')], P17: [claim('Q2')] } },
    Q1: { labels: { en: { value: 'Paris' } }, claims: {
      P131: [claim('Q3', { qualifiers: { P582: date('+1814-00-00T00:00:00Z') } }), claim('Q2', { rank: 'preferred' })],
      P17: [claim('Q3', { qualifiers: { P582: date('+1814-05-00T00:00:00Z') } }), claim('Q2', { rank: 'preferred' })],
    } },
    Q2: { claims: { P297: [{ mainsnak: { datavalue: { value: 'FR' } } }] } },
    Q3: { claims: { P17: [claim('Q4')] } },
    Q4: { claims: { P297: [{ mainsnak: { datavalue: { value: 'DE' } } }] } },
  };
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), true);
  // Ended relationships are ignored even when the provider never marks a current claim preferred.
  entities.Q1.claims.P131[1].rank = 'normal'; entities.Q1.claims.P17[1].rank = 'normal';
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), true);
  entities.Q200.claims.P17.push(claim('Q4'));
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), false);
  entities.Q200.claims.P17[1].qualifiers = { P580: date('+2999-01-01T00:00:00Z') };
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), true);
  // A historical city relationship cannot supply the required current city identity.
  entities.Q200.claims.P131[0].qualifiers = { P582: date('+2000-01-01T00:00:00Z') };
  assert.equal(entityBelongsToDestination('Q200', entities, anchors[1]), false);
});

test('AI cannot invent an attraction, repeat a place, supply prices, or omit geographic transfer time', async () => {
  const places = [place(anchors[1], 0), { ...place(anchors[1], 1), latitude: anchors[1].latitude + 0.04 }];
  const fixture = { days: [{ day: 1, date: start, theme: 'Catalog route', visits: [{ placeId: 'Q200', startMinutes: 600, durationMinutes: 60, participants: 2 }] }] };
  assert.equal(validateGroundedSchedule(JSON.stringify(fixture), places, start, 1, 3).length, 1);
  assert.throws(() => validateGroundedSchedule(JSON.stringify({ ...fixture, estimatedCost: 42 }), places, start, 1, 3));
  const bad = structuredClone(fixture); bad.days[0].visits[0].placeId = 'Q999999';
  assert.throws(() => validateGroundedSchedule(JSON.stringify(bad), places, start, 1, 3), /unknown/);
  const rushed = structuredClone(fixture); rushed.days[0].visits.push({ placeId: 'Q201', startMinutes: 661, durationMinutes: 60, participants: 2 });
  assert.throws(() => validateGroundedSchedule(JSON.stringify(rushed), places, start, 1, 3), /enough time/);
  let calls = 0;
  const provider = { name: 'openai' as const, generate: async () => JSON.stringify(++calls === 1 ? bad : fixture) };
  assert.equal((await generateGroundedSchedule(provider, anchors[1], places, start, 1, 3, 'Budget and preferences')).length, 1);
  assert.equal(calls, 2);
});

test('public photo lookup uses the exact Wikidata image file and attribution, not keyword similarity', async () => {
  const claim = (value: any) => [{ mainsnak: { datavalue: { value } } }];
  let exactFileRequested = false;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'en.wikipedia.org') return Response.json({ query: { pages: { 1: { title: 'Test museum', pageid: 1, coordinates: [{ lat: anchors[1].latitude, lon: anchors[1].longitude }], pageprops: { wikibase_item: 'Q200' } } } } });
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: { Q200: { labels: { en: { value: 'Exact Test Museum' } }, descriptions: { en: { value: 'museum in Paris, France' } }, claims: { P131: claim({ id: 'Q1' }), P17: claim({ id: 'Q2' }), P18: claim('Exact_Test_Museum.jpg') } }, Q1: { labels: { en: { value: 'Paris' } } }, Q2: { claims: { P297: claim('FR') } } } });
    assert.equal(url.hostname, 'commons.wikimedia.org'); exactFileRequested = true;
    assert.equal(url.searchParams.get('titles'), 'File:Exact_Test_Museum.jpg');
    assert.equal(url.searchParams.has('gsrsearch'), false);
    return Response.json({ query: { pages: { 3: { pageid: 3, title: 'File:Exact_Test_Museum.jpg', imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/exact-museum.jpg', extmetadata: { Artist: { value: 'Test photographer' }, LicenseShortName: { value: 'CC BY-SA 4.0' } } }] } } } });
  };
  const places = await retrieveGroundedPlaces(anchors[1], fetcher);
  assert.equal(exactFileRequested, true); assert.equal(places.length, 1);
  assert.equal(places[0].placeId, 'Q200'); assert.match(places[0].imageUrl!, /exact-museum/);
  assert.equal(places[0].imageAttribution?.creator, 'Test photographer');
  assert.equal(places[0].openingHours, 'Opening hours need confirmation');
  const unavailablePhoto = await retrieveGroundedPlaces(anchors[1], async (input, init) => new URL(String(input)).hostname === 'commons.wikimedia.org' ? Response.json({}, { status: 503 }) : fetcher(input, init));
  assert.equal(unavailablePhoto.length, 1); assert.equal(unavailablePhoto[0].imageUrl, undefined);
});

test('quote tokens bind live/test classification, destination, trip context, expiry and currency', () => {
  const data = { kind: 'flight' as const, id: 'flight', name: 'Flight', price: 100, currency: 'EUR', fetchedAt: new Date().toISOString(), isLive: false, destination: 'Paris, France', tripContext: 'dates and party' };
  const token = createTravelSelectionToken(data);
  assert.equal(verifyTravelSelectionToken(data, token), true);
  for (const value of [{ ...data, isLive: true }, { ...data, currency: 'JPY' }, { ...data, destination: 'Tokyo, Japan' }, { ...data, tripContext: 'other dates' }]) assert.equal(verifyTravelSelectionToken(value, token), false);
  const expired = { ...data, fetchedAt: new Date(Date.now() - 3600000).toISOString() };
  assert.equal(verifyTravelSelectionToken(expired, createTravelSelectionToken(expired)), false);
});

test('room quote timestamps, room count and live status cannot be changed; expired quotes fail', () => {
  const offer = { hotelId: 'hotel', offerId: 'offer', name: 'Hotel', currency: 'EUR', nightlyRate: 100, total: 200, rooms: 2, fetchedAt: new Date().toISOString(), isLive: true };
  const token = createOfferToken(offer);
  assert.equal(verifyOfferToken(offer, token), true);
  assert.equal(verifyOfferToken({ ...offer, rooms: 1 }, token), false);
  assert.equal(verifyOfferToken({ ...offer, isLive: false }, token), false);
  const expired = { ...offer, fetchedAt: new Date(Date.now() - 3 * 3600000).toISOString() };
  assert.equal(verifyOfferToken(expired, createOfferToken(expired)), false);
});

test('matching committed attraction price is charged once and quote precision survives room averaging', () => {
  const anchor = anchors[1]; const attraction = place(anchor); const fetchedAt = new Date().toISOString();
  const result = buildGroundedPlan({ destination: 'Paris, France', anchor, startingLocation: 'Toronto', startDate: start, endDate: dateAt(start, 2), budget: 10000, currency: 'EUR', travelers: 3, partyType: 'friends', rooms: 2, places: [attraction], placeDataStatus: 'live', source: 'openai', transportation: 'Taxi',
    foodDailyPerPerson: 10, transportFare: 20, fees: 10, contingencyPercent: 10,
    accommodation: { listingId: 'hotel', name: 'Hotel', address: 'Paris', nightlyRate: 100.03, quotedTotal: 200.05, total: 200.05, nights: 2, rooms: 2, currency: 'EUR', source: 'amadeus', isLive: true, fetchedAt },
    selectedTravelCosts: { activities: [{ id: 'tour', name: attraction.name, travelers: 3, total: 75, unitCost: 25, currency: 'EUR', isLive: true, fetchedAt }], total: 75 },
    schedule: Array.from({ length: 3 }, (_, i) => ({ day: i + 1, date: dateAt(start, i), theme: 'Test', visits: i ? [] : [{ placeId: attraction.placeId, startMinutes: 600, durationMinutes: 60, participants: 2 }] })) });
  assert.equal(result.grounding?.categories.accommodation, 200.05);
  assert.equal(calculateExpense(result.grounding!.accommodation.unitAmount, 2 * 2, 3, 'per-room-night', 'EUR'), 200.05);
  assert.equal(result.grounding?.categories.activities, 75);
  assert.equal(result.days[0].activities[0].estimatedCost, 0);
  assert.equal(result.grounding?.categories.food, 90);
  assert.equal(result.grounding?.categories.transportation, 60);
  assert.equal(result.grounding?.total, 478.56);
  assert.equal(result.grounding?.verifiedAmount, 275.05);
  assert.equal(result.grounding?.accommodation.fetchedAt, fetchedAt);
  assert.equal(parseSavedItinerary(result, { days: 3, budget: 10000, currency: 'EUR', travelers: 3, partyType: 'friends', startDate: start, destination: result.destination }).grounding?.total, 478.56);
});

test('even a server-signed plan cannot save inconsistent activity formulas or category totals', () => {
  for (const modify of [(value: ReturnType<typeof plan>) => { value.days[0].activities[0].priceEvidence!.unitAmount += 1; }, (value: ReturnType<typeof plan>) => { value.grounding!.categories.food += 1; }]) {
    const value = plan(); modify(value); value.groundingProof = signGroundedPlan(value);
    assert.throws(() => parseSavedItinerary(value, { days: 3, budget: value.totalBudget, currency: 'EUR', travelers: 3, partyType: 'friends', startDate: start }), /inconsistent|price basis/);
  }
});

test('available opening-hour references and street addresses are retained and out-of-hours visits fail', () => {
  const entity = { claims: { P3025: [{ mainsnak: { datavalue: { value: { id: 'Q1' } } }, qualifiers: { P8626: [{ datavalue: { value: { id: 'Q2' } } }], P8627: [{ datavalue: { value: { id: 'Q3' } } }] } }], P6375: [{ mainsnak: { datavalue: { value: { language: 'en', text: '10 Test Street, Paris' } } } }] } };
  const entities = { Q1: { labels: { en: { value: 'all days of the week' } } }, Q2: { labels: { en: { value: '10:00' } } }, Q3: { labels: { en: { value: '17:00' } } } };
  const details = openingDetails(entity, entities);
  assert.equal(details.address, '10 Test Street, Paris'); assert.match(details.openingHours, /10:00.*17:00/);
  const attraction = { ...place(anchors[1]), ...details };
  const schedule = { days: [{ day: 1, date: start, theme: 'Test', visits: [{ placeId: attraction.placeId, startMinutes: 540, durationMinutes: 60, participants: 1 }] }] };
  assert.throws(() => validateGroundedSchedule(JSON.stringify(schedule), [attraction], start, 1, 1), /opening-hours/);
  schedule.days[0].visits[0].startMinutes = 600;
  assert.equal(validateGroundedSchedule(JSON.stringify(schedule), [attraction], start, 1, 1).length, 1);
  entity.claims.P3025[0].qualifiers['P3027'] = [{ datavalue: { value: { id: 'Q4' } } }];
  assert.equal(openingDetails(entity, entities).openingWindows, undefined);
});


test('travel pace limits catalog visits and reaches the provider prompt with budget, dates and origin', async () => {
  const anchor = anchors[1], places = Array.from({ length: 4 }, (_, i) => place(anchor, i));
  const raw = JSON.stringify({ days: [{ day: 1, date: start, theme: 'City walk', visits: places.map((p, i) => ({ placeId: p.placeId, startMinutes: 540 + i * 150, durationMinutes: 60, participants: 1 })) }] });
  assert.throws(() => validateGroundedSchedule(raw, places, start, 1, 1, new Set(), 'relaxed'), /pace/);
  assert.throws(() => validateGroundedSchedule(raw, places, start, 1, 1, new Set(), 'balanced'), /pace/);
  assert.equal(validateGroundedSchedule(raw, places, start, 1, 1, new Set(), 'active')[0].visits.length, 4);
  const contexts: string[] = [];
  await generateGroundedSchedule({ generate: async request => { contexts.push(request.userPrompt); return JSON.stringify({ days: [{ day: 1, date: start, theme: 'Slow exploration', visits: [] }] }); } } as import('../src/services/ai/provider.ts').AIItineraryProvider, anchor, places, start, 1, 1, 'Starting location: Toronto, Canada. Budget: EUR 1000. Interests: art.', undefined, 'relaxed');
  assert.match(contexts[0], /at most 2 visits daily at relaxed pace/); assert.match(contexts[0], /PLUS 30 minutes/); assert.match(contexts[0], /Toronto, Canada/); assert.match(contexts[0], /EUR 1000/); assert.match(contexts[0], /art/);
});

test('partial weekday references remain eligible on unreferenced days with an explicit confirmation notice', () => {
  const weekday = new Date(`${start}T00:00:00Z`).getUTCDay();
  const attraction = { ...place(anchors[1]), openingHours: 'Other weekday: 10:00–17:00 (provider reference)', openingWindows: [{ weekdays: [(weekday + 1) % 7], startMinutes: 600, endMinutes: 1020 }] };
  const raw = JSON.stringify({ days: [{ day: 1, date: start, theme: 'Visit', visits: [{ placeId: attraction.placeId, startMinutes: 540, durationMinutes: 90, participants: 1 }] }] });
  const schedule = validateGroundedSchedule(raw, [attraction], start, 1, 1);
  const result = buildGroundedPlan({ destination: 'Paris, France', anchor: anchors[1], startingLocation: '', startDate: start, endDate: start, budget: 1000, currency: 'EUR', travelers: 1, partyType: 'solo', rooms: 1, places: [attraction], placeDataStatus: 'live', source: 'openai', transportation: 'Walking', schedule });
  assert.equal(result.days[0].activities[0].place!.openingHours, attraction.openingHours);
  assert.ok(result.days[0].activities[0].description.startsWith('Opening hours need confirmation.'));
});
