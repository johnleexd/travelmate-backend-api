export type AIProviderName = 'openai' | 'gemini';

export interface AIGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  tripDays: number;
  mode: 'initial' | 'repair';
}

export interface AIItineraryProvider {
  readonly name: AIProviderName;
  generate(request: AIGenerationRequest): Promise<string>;
}

type FetchImplementation = typeof fetch;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function openAIContent(value: unknown): string {
  const root = object(value);
  const choices = root?.choices;
  if (!Array.isArray(choices)) return '';
  const first = object(choices[0]);
  const message = object(first?.message);
  return typeof message?.content === 'string' ? message.content : '';
}

function geminiContent(value: unknown): string {
  const root = object(value);
  const candidates = root?.candidates;
  if (!Array.isArray(candidates)) return '';
  const first = object(candidates[0]);
  const content = object(first?.content);
  const parts = content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => {
    const record = object(part);
    return typeof record?.text === 'string' ? record.text : '';
  }).join('');
}

export class OpenAIItineraryProvider implements AIItineraryProvider {
  readonly name = 'openai' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    apiKey: string,
    model = 'gpt-4o-mini',
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImplementation = fetchImplementation;
  }

  async generate(request: AIGenerationRequest): Promise<string> {
    const response = await this.fetchImplementation('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: request.mode === 'repair' ? 0.2 : 0.7,
        max_tokens: Math.min(8192, 2048 + request.tripDays * 450),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`);
    const content = openAIContent(await response.json());
    if (!content.trim()) throw new Error('OpenAI returned an empty response.');
    return content;
  }
}

export class GeminiItineraryProvider implements AIItineraryProvider {
  readonly name = 'gemini' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImplementation: FetchImplementation;

  constructor(
    apiKey: string,
    model = 'gemini-3.1-flash-lite',
    fetchImplementation: FetchImplementation = fetch,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImplementation = fetchImplementation;
  }

  async generate(request: AIGenerationRequest): Promise<string> {
    const response = await this.fetchImplementation(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${request.systemPrompt}\n\nTraveler request:\n${request.userPrompt}` }] }],
          generationConfig: {
            temperature: request.mode === 'repair' ? 0.2 : 0.7,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(45_000),
      },
    );
    if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
    const content = geminiContent(await response.json());
    if (!content.trim()) throw new Error('Gemini returned an empty response.');
    return content;
  }
}

export interface ResolvedAIProvider {
  name: AIProviderName;
  provider?: AIItineraryProvider;
}

export function resolveAIProvider(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): ResolvedAIProvider {
  const name: AIProviderName = String(environment.AI_PROVIDER || 'openai').toLowerCase() === 'gemini'
    ? 'gemini'
    : 'openai';
  const apiKey = name === 'gemini' ? environment.GEMINI_API_KEY : environment.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) return { name };
  return {
    name,
    provider: name === 'gemini'
      ? new GeminiItineraryProvider(apiKey, environment.GEMINI_MODEL || undefined, fetchImplementation)
      : new OpenAIItineraryProvider(apiKey, environment.OPENAI_MODEL || undefined, fetchImplementation),
  };
}
