import assert from 'node:assert/strict';
import test from 'node:test';
import { generateValidatedItinerary } from '../src/services/ai/itinerary-generator.ts';
import { ItinerarySchemaError, parseGeneratedItinerary } from '../src/services/ai/itinerary-schema.ts';
import type { AIGenerationRequest, AIItineraryProvider } from '../src/services/ai/provider.ts';

function validItinerary() {
  const activities = (label: string) => [
    { time: '08:00 AM', title: `${label} breakfast`, description: 'Breakfast at a named local cafe.', estimatedCost: 200, category: 'food', icon: 'food' },
    { time: '10:00 AM', title: `${label} museum visit`, description: 'Visit a specific local museum.', estimatedCost: 500, category: 'activity', icon: 'map' },
    { time: '01:00 PM', title: `${label} local transfer`, description: 'Take practical local transportation.', estimatedCost: 300, category: 'transport', icon: 'bus' },
  ];
  return {
    destination: 'Cebu City',
    totalBudget: 10_000,
    currency: 'PHP',
    days: [
      { day: 1, date: '2026-10-01', theme: 'Heritage district', travelNote: 'Allow time for traffic.', totalCost: 1_000, activities: activities('Day one') },
      { day: 2, date: '2026-10-02', theme: 'Museum district', travelNote: 'Keep stops in one zone.', totalCost: 1_000, activities: activities('Day two') },
    ],
    budgetSummary: { accommodation: 3_400, food: 2_200, activities: 2_000, transport: 1_400, reserve: 1_000, dailyAverage: 5_000, total: 10_000 },
  };
}

class SequenceProvider implements AIItineraryProvider {
  readonly name = 'openai' as const;
  readonly requests: AIGenerationRequest[] = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async generate(request: AIGenerationRequest): Promise<string> {
    this.requests.push(request);
    return this.responses[this.requests.length - 1] ?? this.responses.at(-1) ?? '';
  }
}

const context = { tripDays: 2, startDate: '2026-10-01', totalBudget: 10_000 };

test('strict itinerary schema accepts a complete date-matched itinerary', () => {
  const result = parseGeneratedItinerary(JSON.stringify(validItinerary()), context);
  assert.equal(result.days.length, 2);
  assert.equal(result.days[1].date, '2026-10-02');
});

test('strict itinerary schema rejects unknown fields and inconsistent totals', () => {
  const invalid = validItinerary() as ReturnType<typeof validItinerary> & { fabricatedStatus?: string };
  invalid.fabricatedStatus = 'confirmed';
  invalid.days[0].totalCost = 999;
  assert.throws(
    () => parseGeneratedItinerary(JSON.stringify(invalid), context),
    (error) => error instanceof ItinerarySchemaError && /Unrecognized key|totalCost/.test(error.message),
  );
});

test('generation repairs one invalid response and validates the replacement', async () => {
  const provider = new SequenceProvider(['not-json', JSON.stringify(validItinerary())]);
  const result = await generateValidatedItinerary({
    provider,
    systemPrompt: 'Return valid JSON.',
    userPrompt: 'Plan the trip.',
    ...context,
  });
  assert.equal(result.currency, 'PHP');
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].mode, 'initial');
  assert.equal(provider.requests[1].mode, 'repair');
  assert.match(provider.requests[1].userPrompt, /Response is not valid JSON/);
});

test('generation stops after one bounded repair attempt', async () => {
  const provider = new SequenceProvider(['{}', '{}', JSON.stringify(validItinerary())]);
  await assert.rejects(
    generateValidatedItinerary({
      provider,
      systemPrompt: 'Return valid JSON.',
      userPrompt: 'Plan the trip.',
      ...context,
    }),
    ItinerarySchemaError,
  );
  assert.equal(provider.requests.length, 2);
});
