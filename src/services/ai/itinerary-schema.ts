import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i;

const activitySchema = z.object({
  time: z.string().trim().regex(TIME, 'Use a 12-hour time such as 09:00 AM.'),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1000),
  estimatedCost: z.number().int().min(0).max(10_000_000),
  category: z.enum(['accommodation', 'food', 'activity', 'transport', 'misc']),
  icon: z.string().trim().min(1).max(32),
}).strict();

const daySchema = z.object({
  day: z.number().int().min(1).max(14),
  date: z.string().regex(ISO_DATE),
  theme: z.string().trim().min(1).max(120),
  travelNote: z.string().trim().min(1).max(500),
  returnToStayAt: z.string().trim().min(1).max(30).optional(),
  totalCost: z.number().int().min(0).max(100_000_000),
  activities: z.array(activitySchema).min(3).max(5),
  weatherAlert: z.string().trim().min(1).max(500).optional(),
}).strict();

const budgetSummarySchema = z.object({
  accommodation: z.number().int().min(0).max(1_000_000_000),
  food: z.number().int().min(0).max(1_000_000_000),
  activities: z.number().int().min(0).max(1_000_000_000),
  transport: z.number().int().min(0).max(1_000_000_000),
  reserve: z.number().int().min(0).max(1_000_000_000),
  dailyAverage: z.number().int().min(0).max(1_000_000_000),
  total: z.number().int().positive().max(1_000_000_000),
}).strict();

const generatedItinerarySchema = z.object({
  destination: z.string().trim().min(2).max(120),
  totalBudget: z.number().int().positive().max(1_000_000_000),
  currency: z.literal('PHP'),
  days: z.array(daySchema).min(1).max(14),
  budgetSummary: budgetSummarySchema,
}).strict();

export type GeneratedItinerary = z.infer<typeof generatedItinerarySchema>;

export interface ItineraryValidationContext {
  tripDays: number;
  startDate: string;
  totalBudget: number;
}

export class ItinerarySchemaError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`AI itinerary validation failed: ${issues.join('; ')}`);
    this.name = 'ItinerarySchemaError';
    this.issues = issues;
  }
}

function expectedDate(startDate: string, offset: number): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function parseGeneratedItinerary(rawContent: string, context: ItineraryValidationContext): GeneratedItinerary {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawContent);
  } catch {
    throw new ItinerarySchemaError(['Response is not valid JSON.']);
  }

  const parsed = generatedItinerarySchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ItinerarySchemaError(parsed.error.issues.slice(0, 12).map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    }));
  }

  const itinerary = parsed.data;
  const issues: string[] = [];
  if (itinerary.days.length !== context.tripDays) issues.push(`days must contain exactly ${context.tripDays} entries`);
  if (itinerary.totalBudget !== context.totalBudget) issues.push(`totalBudget must equal ${context.totalBudget}`);
  if (itinerary.budgetSummary.total !== context.totalBudget) issues.push(`budgetSummary.total must equal ${context.totalBudget}`);
  const allocated = itinerary.budgetSummary.accommodation + itinerary.budgetSummary.food
    + itinerary.budgetSummary.activities + itinerary.budgetSummary.transport + itinerary.budgetSummary.reserve;
  if (allocated !== itinerary.totalBudget) issues.push('budgetSummary category amounts must add up to totalBudget');

  itinerary.days.forEach((day, index) => {
    if (day.day !== index + 1) issues.push(`days.${index}.day must equal ${index + 1}`);
    const date = expectedDate(context.startDate, index);
    if (day.date !== date) issues.push(`days.${index}.date must equal ${date}`);
    const activityTotal = day.activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    if (day.totalCost !== activityTotal) issues.push(`days.${index}.totalCost must equal its activity cost sum (${activityTotal})`);
    if (day.activities.some((activity) => activity.category === 'accommodation')) {
      issues.push(`days.${index}.activities must not include accommodation`);
    }
  });

  if (issues.length) throw new ItinerarySchemaError(issues.slice(0, 12));
  return itinerary;
}
