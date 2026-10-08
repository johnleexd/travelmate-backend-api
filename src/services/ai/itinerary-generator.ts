import { setTimeout as delay } from 'node:timers/promises';
import { ItinerarySchemaError, generatedItineraryJsonSchema, parseGeneratedItinerary, type GeneratedItinerary } from './itinerary-schema.ts';
import { AIProviderError } from './provider-error.ts';
import type { AIItineraryProvider } from './provider.ts';
import type { CurrencyCode } from '../../schemas/domain.ts';

export interface GenerateValidatedItineraryOptions {
  provider: AIItineraryProvider;
  systemPrompt: string;
  userPrompt: string;
  tripDays: number;
  startDate: string;
  totalBudget: number;
  currency: CurrencyCode;
  maxAttempts?: number;
  signal?: AbortSignal;
  maxActivitySpend?: number;
  previousActivityTitles?: string[];
  systemPromptForDays?: (days: number) => string;
}

export async function generateValidatedItinerary(options: GenerateValidatedItineraryOptions): Promise<GeneratedItinerary> {
  const maxAttempts = Math.max(1, Math.min(2, options.maxAttempts ?? 2));
  let userPrompt = options.userPrompt;
  let lastValidationError: ItinerarySchemaError | undefined;
  let transientRetries = 0;
  const responseSchema = generatedItineraryJsonSchema(options.tripDays);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let rawContent: string;
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        rawContent = await options.provider.generate({
          systemPrompt: options.systemPrompt, userPrompt, tripDays: options.tripDays,
          mode: attempt === 1 ? 'initial' : 'repair', responseSchema, signal: options.signal,
        });
        break;
      } catch (error) {
        const temporary = error instanceof AIProviderError ? error.retryable
          : error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
        const waitMs = error instanceof AIProviderError ? error.retryAfterMs ?? 750 + Math.random() * 250 : 750;
        if (!temporary || transientRetries >= 1 || options.signal?.aborted || waitMs > 5000) throw error;
        transientRetries++;
        await delay(waitMs, undefined, { signal: options.signal });
      }
    }
    try {
      return parseGeneratedItinerary(rawContent, {
        tripDays: options.tripDays,
        startDate: options.startDate,
        totalBudget: options.totalBudget,
        currency: options.currency,
        maxActivitySpend: options.maxActivitySpend,
        previousActivityTitles: options.previousActivityTitles,
      });
    } catch (error) {
      if (!(error instanceof ItinerarySchemaError)) throw error;
      lastValidationError = error;
      if (attempt === maxAttempts) break;
      const issueSummary = error.issues.join('\n- ');
      userPrompt = `${options.userPrompt}\n\nRepair the previous response. Return a complete replacement JSON object only.\nValidation issues:\n- ${issueSummary}\n\nPrevious invalid response:\n${rawContent.slice(0, 20_000)}`;
    }
  }

  throw lastValidationError ?? new ItinerarySchemaError(['The provider did not return a usable itinerary.']);
}

/** Validate each bounded segment and then the entire plan before returning any result. */
export async function generateBatchedItinerary(options: GenerateValidatedItineraryOptions): Promise<GeneratedItinerary> {
  if (!Number.isInteger(options.tripDays) || options.tripDays < 1 || options.tripDays > 31) {
    throw new ItinerarySchemaError(['Trip length must be between 1 and 31 days, including both dates.']);
  }
  if (options.tripDays <= 7) return generateValidatedItinerary(options);
  const days: GeneratedItinerary['days'] = [];
  let result: GeneratedItinerary | undefined;
  let remainingUnits = options.maxActivitySpend === undefined ? undefined : Math.floor(options.maxActivitySpend * 100);
  const dateAt = (offset: number) => {
    const date = new Date(`${options.startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  for (let offset = 0; offset < options.tripDays; offset += 7) {
    options.signal?.throwIfAborted();
    const count = Math.min(7, options.tripDays - offset);
    const limit = remainingUnits === undefined ? undefined : Math.floor(remainingUnits * count / (options.tripDays - offset)) / 100;
    const previousActivityTitles = days.flatMap((day) => day.activities.map((activity) => activity.title));
    const continuity = days.length ? JSON.stringify(days.slice(-2)) : 'This is the first segment.';
    const segment = await generateValidatedItinerary({
      ...options,
      tripDays: count, startDate: dateAt(offset), maxActivitySpend: limit, previousActivityTitles,
      systemPrompt: options.systemPromptForDays?.(count) ?? `${options.systemPrompt}\nFor this response only, return exactly ${count} days numbered 1 through ${count}.`,
      userPrompt: `${options.userPrompt}\n\nSEGMENT INSTRUCTIONS (override the full-trip day count and start date above): Generate only trip days ${offset + 1}–${offset + count}, dated ${dateAt(offset)} through ${dateAt(offset + count - 1)}. Return exactly ${count} days, numbered locally 1 through ${count}. The overall trip ends ${dateAt(options.tripDays - 1)}. Do not schedule a final departure at a segment boundary; retain the same destination, selected stay, route continuity and pace. Arrival occurs only in the first segment and final departure only on the overall end date. totalBudget and budgetSummary describe the ONE overall trip budget (${options.totalBudget} ${options.currency}), not a new budget for this segment. ${limit === undefined ? '' : `The sum of ALL per-traveler activity costs in this segment must be at most ${limit} ${options.currency}. Keep real price estimates; choose affordable real places rather than reducing their prices.`}\nPrevious segment ending (continue its route): ${continuity}\nDo not repeat any of these previous activity titles or the underlying visits: ${JSON.stringify(previousActivityTitles)}.`,
    });
    result ??= segment;
    days.push(...segment.days.map((day, index) => ({ ...day, day: offset + index + 1 })));
    if (remainingUnits !== undefined) remainingUnits -= segment.days.reduce((sum, day) => sum + Math.round(day.totalCost * 100), 0);
  }
  return parseGeneratedItinerary(JSON.stringify({ ...result!, days, budgetSummary: { ...result!.budgetSummary, dailyAverage: Math.round(options.totalBudget / options.tripDays * 100) / 100 } }), options);
}
