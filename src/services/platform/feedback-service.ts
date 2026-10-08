import { notifyAdmins } from './admin-notification-service.ts';
import { publishReportChange } from './report-events.ts';
import { parseSavedItinerary } from '../itinerary/saved-trip-schema.ts';
import { normalizeCurrency } from '../../schemas/domain.ts';
import { prisma } from '../../lib/prisma.ts';
import { PlatformActionError } from '../../exceptions/index.ts';
import type { PublicUser } from '../../schemas/domain.ts';
import type { Prisma } from '../../generated/prisma/client.ts';

export const FEEDBACK_CATEGORIES = ['budget_accuracy', 'weather_info', 'ai_cohesion', 'route_efficiency'] as const;
const sentiments = ['not_analyzed', 'positive', 'neutral', 'negative'] as const;

export function validateFeedback(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlatformActionError('A feedback object is required.');
  const body = value as Record<string, unknown>;
  const itineraryId = typeof body.itineraryId === 'string' ? body.itineraryId.trim() : '';
  const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
  if (!itineraryId || itineraryId.length > 200) throw new PlatformActionError('A saved itinerary ID is required.');
  if (typeof body.rating !== 'number' || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) throw new PlatformActionError('Rating must be an integer from 1 to 5.');
  if (!FEEDBACK_CATEGORIES.includes(body.category as typeof FEEDBACK_CATEGORIES[number])) throw new PlatformActionError('Choose a supported feedback category.');
  if (comment.length < 10 || comment.length > 2000) throw new PlatformActionError('Comment must be between 10 and 2000 characters.');
  return { itineraryId, rating: body.rating, category: body.category as typeof FEEDBACK_CATEGORIES[number], comment, sentiment: 'not_analyzed' as const };
}

function dateBoundary(text: string | null, field: string) {
  if (!text) return undefined;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new PlatformActionError(`${field} must be a valid date.`);
  return date;
}

export function feedbackQuery(params: URLSearchParams) {
  const search = (params.get('q') || '').trim();
  if (search.length > 200) throw new PlatformActionError('Feedback search must be at most 200 characters.');
  const rating = params.get('rating');
  const sentiment = params.get('sentiment');
  if (rating && !/^[1-5]$/.test(rating)) throw new PlatformActionError('Rating filter must be from 1 to 5.');
  if (sentiment && !sentiments.includes(sentiment as typeof sentiments[number])) throw new PlatformActionError('Invalid sentiment filter.');
  const from = dateBoundary(params.get('from'), 'Start date');
  const to = dateBoundary(params.get('to'), 'End date');
  if (from && to && from > to) throw new PlatformActionError('Start date cannot be after end date.');
  if (to) to.setUTCDate(to.getUTCDate() + 1);
  const pageText = params.get('page') || '1';
  const page = Number(pageText);
  if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new PlatformActionError('Page must be a positive integer up to 1000000.');
  const where: Prisma.FeedbackWhereInput = {
    ...(search ? { OR: [
      { comment: { contains: search, mode: 'insensitive' as const } },
      { user: { is: { name: { contains: search, mode: 'insensitive' as const } } } },
      { user: { is: { email: { contains: search, mode: 'insensitive' as const } } } },
      { itinerary: { is: { destination: { contains: search, mode: 'insensitive' as const } } } },
    ] } : {}),
    ...(rating ? { rating: Number(rating) } : {}),
    ...(sentiment ? { sentiment: sentiment as typeof sentiments[number] } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  return { where, page, pageSize: 10 };
}

export async function submitFeedback(user: PublicUser, value: unknown) {
  if (user.role !== 'traveler') throw new PlatformActionError('Only travelers can submit itinerary feedback.');
  const input = validateFeedback(value);
  const result = await prisma.$transaction(async transaction => {
    // Lock the owned trip so deletion cannot race the feedback insertion.
    const owned = await transaction.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "trips" WHERE "id" = ${input.itineraryId} AND "user_id" = ${user.id} FOR UPDATE`;
    if (!owned.length) throw new PlatformActionError('Saved itinerary not found for this account.');
    const existing = await transaction.feedback.findUnique({ where: { userId_itineraryId: { userId: user.id, itineraryId: input.itineraryId } } });
    const created = await transaction.feedback.upsert({
      where: { userId_itineraryId: { userId: user.id, itineraryId: input.itineraryId } },
      create: { ...input, userId: user.id }, update: input,
    });
    await transaction.auditEvent.create({ data: { actorId: user.id, action: existing ? 'update-feedback' : 'submit-feedback', targetId: created.id } });
    await notifyAdmins(transaction, 'feedback', 'New feedback received', user.name + ' rated their itinerary ' + input.rating + ' out of 5.', created.id);
    return serializeFeedback(created);
  });
  publishReportChange();
  return result;
}

function serializeFeedback(row: { id: string; rating: number; category: string; comment: string; sentiment: string; createdAt: Date; updatedAt: Date }) {
  return { id: row.id, rating: row.rating, category: row.category, comment: row.comment, sentiment: row.sentiment, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function ownFeedback(user: PublicUser, itineraryId: string) {
  if (!itineraryId || itineraryId.length > 200) throw new PlatformActionError('A saved itinerary ID is required.');
  const trip = await prisma.trip.findFirst({ where: { id: itineraryId, userId: user.id }, select: { id: true } });
  if (!trip) throw new PlatformActionError('Saved itinerary not found for this account.');
  const row = await prisma.feedback.findUnique({ where: { userId_itineraryId: { userId: user.id, itineraryId } } });
  return row ? serializeFeedback(row) : null;
}

export async function listFeedback(params: URLSearchParams) {
  const query = feedbackQuery(params);
  return prisma.$transaction(async transaction => {
    const total = await transaction.feedback.count({ where: query.where });
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / query.pageSize)));
    const rows = await transaction.feedback.findMany({
      where: query.where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * query.pageSize, take: query.pageSize,
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } }, itinerary: { select: { id: true, destination: true } } },
    });
    return { entries: rows.map(row => ({ ...row, user: row.user ? { ...row.user, avatarUrl: row.user.avatarUrl ?? undefined } : null, createdAt: row.createdAt.toISOString() })), total, page, pageSize: query.pageSize };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function feedbackItinerary(id: string) {
  const feedback = await prisma.feedback.findUnique({ where: { id }, select: { itinerary: { select: { id: true, destination: true, startDate: true, endDate: true, budget: true, currency: true, travelers: true, partyType: true, itinerary: true, updatedAt: true } } } });
  if (!feedback?.itinerary) return null;
  const trip = feedback.itinerary;
  let content = null;
  try {
    content = parseSavedItinerary(trip.itinerary, { days: Math.round((trip.endDate.getTime() - trip.startDate.getTime()) / 86400000) + 1, currency: normalizeCurrency(trip.currency), budget: Number(trip.budget), travelers: trip.travelers, partyType: trip.partyType });
  } catch { /* Legacy or malformed saved content remains identifiable through its metadata. */ }
  return { ...trip, itinerary: content, budget: Number(trip.budget), startDate: trip.startDate.toISOString().slice(0, 10), endDate: trip.endDate.toISOString().slice(0, 10), updatedAt: trip.updatedAt.toISOString() };
}

/** Admin detail lookup is independent of history pagination and filters. */
export async function feedbackDetails(id: string) {
  if (!id || id.length > 200) throw new PlatformActionError('A valid feedback ID is required.');
  const row = await prisma.feedback.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } }, itinerary: { select: { id: true, destination: true } } },
  });
  return row ? { ...row, user: row.user ? { ...row.user, avatarUrl: row.user.avatarUrl ?? undefined } : null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } : null;
}
