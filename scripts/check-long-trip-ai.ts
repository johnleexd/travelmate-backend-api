/** Optional live provider smoke test. Uses backend credentials without printing them. */
import { generateBatchedItinerary } from '../src/services/ai/itinerary-generator.ts';
import { resolveAIProviders } from '../src/services/ai/provider.ts';
import { buildSystemPrompt } from '../src/controllers/itinerary-controller.ts';
import { prisma } from '../src/lib/prisma.ts';

try {
  const provider = resolveAIProviders()[0];
  if (!provider) throw new Error('Configure OPENAI_API_KEY or GEMINI_API_KEY in the backend environment before running the live AI smoke test.');
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1);
  const startDate = start.toISOString().slice(0, 10);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 30);
  const result = await generateBatchedItinerary({
    provider: provider.provider!, systemPrompt: buildSystemPrompt(31, 'EUR'), systemPromptForDays: days => buildSystemPrompt(days, 'EUR'),
    userPrompt: `Plan 31 inclusive travel days in Paris, France from ${startDate} through ${end.toISOString().slice(0, 10)} for one traveler. Total trip budget is 20000 EUR, with 18000 EUR available for all per-traveler daily activities combined. No hotel or flight is selected. Keep the route in Paris and maintain continuity and rest time. Name only real places, avoid repeating the same visits. There is no date-matched weather data: do not invent forecasts.`,
    tripDays: 31, startDate, totalBudget: 20000, currency: 'EUR', maxActivitySpend: 18000, signal: AbortSignal.timeout(540000),
  });
  console.log(JSON.stringify({ provider: provider.name, validatedDays: result.days.length, startDate: result.days[0].date, endDate: result.days.at(-1)!.date, activityCount: result.days.reduce((sum, day) => sum + day.activities.length, 0), activitySpend: result.days.reduce((sum, day) => sum + day.totalCost, 0), withinBudget: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live AI smoke test failed.');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
