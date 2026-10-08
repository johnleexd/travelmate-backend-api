import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBatchedItinerary } from '../src/services/ai/itinerary-generator.ts';
import { parseGeneratedItinerary } from '../src/services/ai/itinerary-schema.ts';
import type { AIGenerationRequest, AIItineraryProvider } from '../src/services/ai/provider.ts';
import { buildSystemPrompt, normalizeItinerary } from '../src/controllers/itinerary-controller.ts';
import { allocateDailyBudget, allocateNightlyCosts, splitBudget } from '../src/schemas/domain.ts';
import { parseSavedItinerary, parseSavedWeather } from '../src/services/itinerary/saved-trip-schema.ts';
import { estimateCrowdRange } from '../src/services/crowd/crowd-service.ts';
import { unavailableWeather, validateWeatherDateRange, weatherForTripDates } from '../src/services/weather/weather-domain.ts';

const startDate = '2040-01-25';
const dateAt = (offset: number) => new Date(Date.parse(startDate) + offset * 86_400_000).toISOString().slice(0, 10);
const budget = 100_000;
export function generatedFixture(count: number, offset = 0) {
  return {
    destination: 'Paris, France', totalBudget: budget, currency: 'EUR' as const,
    budgetSummary: { accommodation: 34000, food: 22000, activities: 20000, transport: 14000, reserve: 10000, dailyAverage: Math.round(budget / count * 100) / 100, total: budget },
    days: Array.from({ length: count }, (_, i) => ({
      day: i + 1, date: dateAt(offset + i), theme: `Zone ${offset + i + 1}`, travelNote: 'Continue from the previous neighborhood with time for walking.', totalCost: 30,
      activities: ['09:00 AM', '12:00 PM', '03:00 PM'].map((time, j) => ({ time, title: `Fixture named venue ${offset + i + 1} ${j}`, description: 'Test fixture for a named place.', estimatedCost: 10, category: 'activity' as const, icon: 'map' })),
    })),
  };
}

class SegmentedProvider implements AIItineraryProvider {
  readonly name = 'openai' as const;
  requests: AIGenerationRequest[] = [];
  offset = 0;
  fault?: 'duplicate' | 'truncate' | 'expensive';
  repaired = false;
  async generate(request: AIGenerationRequest) {
    this.requests.push(request);
    const value = generatedFixture(request.tripDays, this.offset);
    if (this.offset === 7 && this.fault && !this.repaired) {
      this.repaired = true;
      if (this.fault === 'duplicate') value.days[0].activities[0].title = generatedFixture(1).days[0].activities[0].title;
      if (this.fault === 'truncate') value.days.pop();
      if (this.fault === 'expensive') { value.days[0].activities[0].estimatedCost = budget; value.days[0].totalCost = budget + 20; }
    } else this.offset += request.tripDays;
    return JSON.stringify(value);
  }
}

for (const count of [1, 14, 21, 28, 31]) {
  test(`${count}-day trip covers inclusive dates across a month boundary, budgets, nights and persistence`, async () => {
    const provider = new SegmentedProvider();
    const generated = await generateBatchedItinerary({ provider, systemPrompt: buildSystemPrompt(count, 'EUR'), systemPromptForDays: days => buildSystemPrompt(days, 'EUR'), userPrompt: 'Plan a trip.', tripDays: count, startDate, totalBudget: budget, currency: 'EUR', maxActivitySpend: count * 30 });
    assert.equal(generated.days.length, count);
    assert.equal(generated.days.at(-1)?.date, dateAt(count - 1));
    assert.equal(provider.requests.length, Math.ceil(count / 7));
    assert.ok(provider.requests.every(request => request.tripDays <= 7));
    generated.days.forEach((day, i) => { assert.equal(day.day, i + 1); assert.equal(day.date, dateAt(i)); });
    if (count > 7) { assert.match(provider.requests[1].userPrompt, /previous activity titles/); assert.match(provider.requests[1].userPrompt, /Fixture named venue 1 0/); assert.match(provider.requests[1].userPrompt, /Do not schedule a final departure/); }
    const summary = splitBudget(budget, 3, count);
    const plan = normalizeItinerary({ ...generated, days: generated.days.map(day => ({ ...day, imageUrl: '' })) }, summary, 'friends', 3, count, startDate, { listingId: 'test', name: 'Test stay', address: 'Paris', currency: 'EUR', nightlyRate: 100, source: 'travelmate' }, { activities: [], total: 100, flight: { id: 'f', name: 'Flight', total: 100, currency: 'EUR', fetchedAt: new Date().toISOString() } });
    assert.equal(plan.accommodation?.nights, Math.max(1, count - 1));
    assert.equal(plan.accommodation?.total, Math.max(1, count - 1) * 100);
    assert.equal(plan.budgetSummary.plannedSpend, count * 30 * 3 + Math.max(1, count - 1) * 100 + 100);
    assert.ok(plan.budgetSummary.plannedSpend! <= budget);
    assert.equal(parseSavedItinerary(plan, { days: count, currency: 'EUR', budget, travelers: 3, partyType: 'friends', startDate }).days.length, count);
    assert.equal(allocateDailyBudget(budget, summary.reserve, count).length, count);
    const crowd = estimateCrowdRange(startDate, dateAt(count - 1), 'Paris');
    assert.equal(crowd.length, count);
    const now = new Date().toISOString();
    assert.equal(parseSavedWeather({ ...unavailableWeather('Paris'), crowd, fetchedAt: now, refreshAfter: now, freshness: { source: 'weather', status: 'unavailable', isStale: false, fetchedAt: now, expiresAt: now, staleUntil: now, policy: 'Test fixture' } })?.crowd.length, count);
    assert.equal(validateWeatherDateRange(startDate, dateAt(count - 1)).error, undefined);
  });
}

for (const fault of ['duplicate', 'truncate', 'expensive'] as const) {
  test(`long-trip ${fault} segment is repaired before merging`, async () => {
    const provider = new SegmentedProvider(); provider.fault = fault;
    const result = await generateBatchedItinerary({ provider, systemPrompt: 'JSON', userPrompt: 'Trip', tripDays: 14, startDate, totalBudget: budget, currency: 'EUR', maxActivitySpend: 420 });
    assert.equal(result.days.length, 14);
    assert.equal(provider.requests.length, 3);
    assert.equal(provider.requests[2].mode, 'repair');
  });
}

test('32 days, missing days, shifted saved dates and excessive activity spending are rejected', async () => {
  await assert.rejects(generateBatchedItinerary({ provider: new SegmentedProvider(), systemPrompt: '', userPrompt: '', tripDays: 32, startDate, totalBudget: budget, currency: 'EUR' }), /1 and 31/);
  assert.throws(() => splitBudget(budget, 1, 32), /1 and 31/);
  assert.equal(validateWeatherDateRange(startDate, dateAt(31)).error, 'Weather date range cannot exceed 31 days.');
  const fixture = generatedFixture(31);
  assert.throws(() => parseGeneratedItinerary(JSON.stringify(fixture), { tripDays: 31, startDate, totalBudget: budget, currency: 'EUR', maxActivitySpend: 1 }), /exceed/);
  assert.throws(() => normalizeItinerary({ ...fixture, days: [] }, splitBudget(budget, 1, 31), 'solo', 1, 31, startDate), /every selected/);
  assert.throws(() => parseSavedItinerary({ ...fixture, days: fixture.days.map(day => ({ ...day, imageUrl: '' })) }, { days: 31, startDate: dateAt(1), budget, currency: 'EUR', travelers: 1, partyType: 'solo' }), /corresponding trip date/);
});

test('31-day weather retains only actual provider dates and never extends the forecast', () => {
  const forecast = Array.from({ length: 14 }, (_, i) => ({ date: dateAt(i), tempMin: 10, tempMax: 20, precipitationProbability: 0, description: 'clear', icon: '01d', iconUrl: '' }));
  const result = weatherForTripDates({ ...unavailableWeather('Paris'), source: 'open-meteo', forecast }, startDate, dateAt(30));
  assert.equal(result.forecast.length, 14);
  assert.match(result.forecastMessage!, /14 of 31/);
  assert.equal(result.forecast.some(day => day.date === dateAt(30)), false);
});

test('30-night quotes reconcile exactly in decimal and whole-unit currencies', () => {
  const euro = allocateNightlyCosts(3000.99, 30, 'EUR');
  assert.equal(Math.round(euro.reduce((sum, amount) => sum + amount, 0) * 100), 300099);
  const yen = allocateNightlyCosts(300001, 30, 'JPY');
  assert.equal(yen.reduce((sum, amount) => sum + amount, 0), 300001);
  assert.ok(yen.every(Number.isInteger));
  const fixture = generatedFixture(31);
  fixture.days[0].activities[0].estimatedCost = 10.5; fixture.days[0].totalCost = 30.5;
  assert.throws(() => parseGeneratedItinerary(JSON.stringify({ ...fixture, currency: 'JPY' }), { tripDays: 31, startDate, totalBudget: budget, currency: 'JPY' }), /currency precision/);
});
