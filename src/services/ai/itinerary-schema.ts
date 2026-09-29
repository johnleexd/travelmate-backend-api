import { z } from 'zod';
import { SUPPORTED_CURRENCIES, type CurrencyCode } from '../../schemas/domain.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i;
const money = (maximum: number, positive = false) => z.number()
  .min(positive ? 0.01 : 0)
  .max(maximum)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Use at most two decimal places.');
const minorUnits = (value: number) => Math.round(value * 100);
const GENERIC_ACTIVITY_TITLE = /^(cafe break|coffee break|breakfast|lunch|dinner|traditional (?:breakfast|lunch|dinner)|local transport|public transport|free time|leisure time|city exploration|city experience|sightseeing|shopping)$/i;

const activitySchema = z.object({
  time: z.string().trim().regex(TIME, 'Use a 12-hour time such as 09:00 AM.'),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1000),
  estimatedCost: money(10_000_000),
  category: z.enum(['accommodation', 'food', 'activity', 'transport', 'misc']),
  icon: z.string().trim().min(1).max(32),
}).strict();

const daySchema = z.object({
  day: z.number().int().min(1).max(14),
  date: z.string().regex(ISO_DATE),
  theme: z.string().trim().min(1).max(120),
  travelNote: z.string().trim().min(1).max(500),
  returnToStayAt: z.string().trim().min(1).max(30).optional(),
  totalCost: money(100_000_000),
  activities: z.array(activitySchema).min(3).max(5),
  weatherAlert: z.string().trim().min(1).max(500).optional(),
}).strict();

const budgetSummarySchema = z.object({
  accommodation: money(1_000_000_000),
  food: money(1_000_000_000),
  activities: money(1_000_000_000),
  transport: money(1_000_000_000),
  reserve: money(1_000_000_000),
  dailyAverage: money(1_000_000_000),
  total: money(1_000_000_000, true),
}).strict();

const generatedItinerarySchema = z.object({
  destination: z.string().trim().min(2).max(120),
  totalBudget: money(1_000_000_000, true),
  currency: z.enum(SUPPORTED_CURRENCIES),
  days: z.array(daySchema).min(1).max(14),
  budgetSummary: budgetSummarySchema,
}).strict();

export type GeneratedItinerary = z.infer<typeof generatedItinerarySchema>;

export interface ItineraryValidationContext {
  tripDays: number;
  startDate: string;
  totalBudget: number;
  currency: CurrencyCode;
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

function minutesFromTime(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/i);
  if (!match) return -1;
  const hour = Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return hour * 60 + Number(match[2]);
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
  if (minorUnits(itinerary.totalBudget) !== minorUnits(context.totalBudget)) issues.push(`totalBudget must equal ${context.totalBudget}`);
  if (itinerary.currency !== context.currency) issues.push(`currency must equal ${context.currency}`);
  if (minorUnits(itinerary.budgetSummary.total) !== minorUnits(context.totalBudget)) issues.push(`budgetSummary.total must equal ${context.totalBudget}`);
  const allocated = itinerary.budgetSummary.accommodation + itinerary.budgetSummary.food
    + itinerary.budgetSummary.activities + itinerary.budgetSummary.transport + itinerary.budgetSummary.reserve;
  if (minorUnits(allocated) !== minorUnits(itinerary.totalBudget)) issues.push('budgetSummary category amounts must add up to totalBudget');

  itinerary.days.forEach((day, index) => {
    if (day.day !== index + 1) issues.push(`days.${index}.day must equal ${index + 1}`);
    const date = expectedDate(context.startDate, index);
    if (day.date !== date) issues.push(`days.${index}.date must equal ${date}`);
    const activityTotal = day.activities.reduce((sum, activity) => sum + activity.estimatedCost, 0);
    if (minorUnits(day.totalCost) !== minorUnits(activityTotal)) issues.push(`days.${index}.totalCost must equal its activity cost sum (${activityTotal})`);
    if (day.activities.some((activity) => activity.category === 'accommodation')) {
      issues.push(`days.${index}.activities must not include accommodation`);
    }
    day.activities.forEach((activity, activityIndex) => {
      if (GENERIC_ACTIVITY_TITLE.test(activity.title.trim())) {
        issues.push(`days.${index}.activities.${activityIndex}.title must name a specific real place`);
      }
    });
    for (let activityIndex = 1; activityIndex < day.activities.length; activityIndex += 1) {
      if (minutesFromTime(day.activities[activityIndex].time) <= minutesFromTime(day.activities[activityIndex - 1].time)) {
        issues.push(`days.${index}.activities must use strictly increasing times`);
        break;
      }
    }
  });

  const seenActivities = new Set<string>();
  itinerary.days.forEach((day, dayIndex) => day.activities.forEach((activity, activityIndex) => {
    const key = activity.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seenActivities.has(key)) issues.push(`days.${dayIndex}.activities.${activityIndex}.title duplicates another itinerary activity`);
    seenActivities.add(key);
  }));

  if (issues.length) throw new ItinerarySchemaError(issues.slice(0, 12));
  return itinerary;
}
