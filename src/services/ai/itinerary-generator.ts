import { ItinerarySchemaError, parseGeneratedItinerary, type GeneratedItinerary } from './itinerary-schema.ts';
import type { AIItineraryProvider } from './provider.ts';

export interface GenerateValidatedItineraryOptions {
  provider: AIItineraryProvider;
  systemPrompt: string;
  userPrompt: string;
  tripDays: number;
  startDate: string;
  totalBudget: number;
  maxAttempts?: number;
}

export async function generateValidatedItinerary(options: GenerateValidatedItineraryOptions): Promise<GeneratedItinerary> {
  const maxAttempts = Math.max(1, Math.min(2, options.maxAttempts ?? 2));
  let userPrompt = options.userPrompt;
  let lastValidationError: ItinerarySchemaError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rawContent = await options.provider.generate({
      systemPrompt: options.systemPrompt,
      userPrompt,
      tripDays: options.tripDays,
      mode: attempt === 1 ? 'initial' : 'repair',
    });
    try {
      return parseGeneratedItinerary(rawContent, {
        tripDays: options.tripDays,
        startDate: options.startDate,
        totalBudget: options.totalBudget,
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
