import assert from 'node:assert/strict';
import test from 'node:test';
import { generateValidatedItinerary } from '../src/services/ai/itinerary-generator.ts';
import { ItinerarySchemaError, parseGeneratedItinerary } from '../src/services/ai/itinerary-schema.ts';
import type { AIGenerationRequest, AIItineraryProvider } from '../src/services/ai/provider.ts';
import { GeminiItineraryProvider, mockItinerariesEnabled, resolveAIProviders } from '../src/services/ai/provider.ts';

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

const context = { tripDays: 2, startDate: '2026-10-01', totalBudget: 10_000, currency: 'PHP' as const };

test('mock itineraries require an explicit non-production flag', () => {
  assert.equal(mockItinerariesEnabled({ NODE_ENV: 'development', AI_MOCK_FALLBACK: 'true' }), true);
  assert.equal(mockItinerariesEnabled({ NODE_ENV: 'development' }), false);
  assert.equal(mockItinerariesEnabled({ NODE_ENV: 'production', AI_MOCK_FALLBACK: 'true' }), false);
});

test('AI providers resolve in preferred order and include only configured fallbacks', () => {
  const providers = resolveAIProviders({
    AI_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'gemini-test-key',
    OPENAI_API_KEY: 'openai-test-key',
  });
  assert.deepEqual(providers.map((provider) => provider.name), ['gemini', 'openai']);

  const primaryOnly = resolveAIProviders({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-test-key' });
  assert.deepEqual(primaryOnly.map((provider) => provider.name), ['openai']);
});

test('Gemini 3 receives system instructions, JSON output, supported temperature, and a trip-sized token budget', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new GeminiItineraryProvider('test-gemini-key', 'gemini-3.1-flash-lite', async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });
  });

  assert.equal(await provider.generate({ systemPrompt: 'System rules', userPrompt: 'Build a trip', tripDays: 7, mode: 'repair' }), '{"ok":true}');
  assert.match(requestUrl, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(new Headers(requestInit?.headers).get('x-goog-api-key'), 'test-gemini-key');
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.systemInstruction.parts[0].text, 'System rules');
  assert.equal(body.contents[0].parts[0].text, 'Build a trip');
  assert.equal(body.generationConfig.temperature, 1);
  assert.equal(body.generationConfig.maxOutputTokens, 18_432);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
});

test('Gemini errors retain the provider diagnostic without exposing credentials', async () => {
  const provider = new GeminiItineraryProvider('secret-key', 'gemini-3.1-flash-lite', async () => Response.json({
    error: { message: 'API key not valid. Please pass a valid API key.', status: 'PERMISSION_DENIED' },
  }, { status: 403 }));

  await assert.rejects(provider.generate({ systemPrompt: '', userPrompt: '', tripDays: 1, mode: 'initial' }), (error) => {
    assert.match((error as Error).message, /Gemini request failed \(403\): API key not valid/);
    assert.doesNotMatch((error as Error).message, /secret-key/);
    return true;
  });
});

test('strict itinerary schema enforces the requested currency', () => {
  const usd = { ...validItinerary(), currency: 'USD' };
  assert.throws(
    () => parseGeneratedItinerary(JSON.stringify(usd), context),
    (error) => error instanceof ItinerarySchemaError && /currency must equal PHP/.test(error.message),
  );
});

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

test('strict itinerary schema rejects generic or duplicated activity titles', () => {
  const generic = validItinerary();
  generic.days[0].activities[0].title = 'Cafe Break';
  assert.throws(
    () => parseGeneratedItinerary(JSON.stringify(generic), context),
    (error) => error instanceof ItinerarySchemaError && /must name a specific real place/.test(error.message),
  );

  const duplicated = validItinerary();
  duplicated.days[1].activities[0].title = duplicated.days[0].activities[0].title;
  assert.throws(
    () => parseGeneratedItinerary(JSON.stringify(duplicated), context),
    (error) => error instanceof ItinerarySchemaError && /duplicates another itinerary activity/.test(error.message),
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
