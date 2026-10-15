import { publishReportChange } from './report-events.ts';
import type { ItineraryResponse } from '../../controllers/itinerary-controller.ts';
import { retainSelectedActivityPhotos, retainStoredActivityPhotos } from '../itinerary/saved-activity-photos.ts';
import { recordVisit, recordTripVisits, removeVisit } from './visited-place-service.ts';
import { saveIdentity } from './save-idempotency.ts';
import {
  Prisma,
  type Trip as PrismaTrip,
} from "../../generated/prisma/client.ts";
import {
  ItineraryEditValidationError,
  PlatformActionError,
} from "../../exceptions/index.ts";
import { hasValidCurrencyPrecision, normalizeCurrency, publicUser, splitBudget, travelersForParty, ZERO_DECIMAL_CURRENCIES, type CurrencyCode, type PartyType, type PublicUser } from "../../schemas/domain.ts";
import { prisma } from "../../lib/prisma.ts";
import { submitReport, resolveReport } from './report-service.ts';
import { sendUserWarning } from './user-warning-service.ts';
import { reviewAppeal } from './appeal-service.ts';
import { applyManualItineraryChanges } from "../itinerary/itinerary-edit-service.ts";
import { parseSavedItinerary, parseSavedWeather } from "../itinerary/saved-trip-schema.ts";
import { createVersionSnapshot, readVersionSnapshot } from '../itinerary/version-snapshot.ts';

type Body = Record<string, unknown>;
type Transaction = Prisma.TransactionClient;

function fail(message: string): never {
  throw new PlatformActionError(message);
}

function requireRole(user: PublicUser, role: PublicUser["role"]): void {
  if (user.role !== role) fail("Action is not allowed for this account.");
}

function identifier(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) fail("A valid record identifier is required.");
  return id;
}

function wholeNumber(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function positiveMoney(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000) fail(`${field} must be between 0.01 and 1,000,000,000.`);
  return Math.round(number * 100) / 100;
}


function dateOnly(value: unknown, field: string): Date {
  const text = typeof value === "string" ? value : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${field} must use YYYY-MM-DD format.`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${field} is invalid.`);
  return date;
}

function tripLength(startDate: Date, endDate: Date): number {
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
  if (!Number.isInteger(days) || days < 1 || days > 31) fail("Trip dates must cover between 1 and 31 days.");
  return days;
}


function stringList(value: unknown, maximum = 20): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return items.map(String).map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, maximum);
}

function itineraryInput(value: unknown, days: number, currency: CurrencyCode, budget: number, travelers: number, partyType: PartyType, startDate: Date, destination: string): Prisma.InputJsonValue {
  try {
    const parsed = parseSavedItinerary(value, { days, currency, budget, travelers, partyType, destination, startDate: startDate.toISOString().slice(0, 10) });
    return retainSelectedActivityPhotos(parsed as ItineraryResponse) as unknown as Prisma.InputJsonValue;
  } catch (error) {
    fail(error instanceof Error ? error.message : "Itinerary is invalid.");
  }
}


function weatherInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  try {
    const weather = parseSavedWeather(value);
    return weather === null ? Prisma.DbNull : weather as Prisma.InputJsonValue;
  } catch (error) {
    fail(error instanceof Error ? error.message : "Weather snapshot is invalid.");
  }
}

function groundedDestination(itinerary: Prisma.InputJsonValue, submitted: ReturnType<typeof destinationContext>) {
  const anchor = (itinerary as unknown as import('../../controllers/itinerary-controller.ts').ItineraryResponse).grounding?.destination;
  if (!anchor) return submitted;
  if ('destinationCity' in submitted && (submitted.destinationCity !== anchor.city || submitted.destinationCountryCode !== anchor.countryCode || submitted.latitude !== anchor.latitude || submitted.longitude !== anchor.longitude)) fail('Saved destination details do not match the grounded itinerary.');
  return { ...submitted, destinationCity: anchor.city, destinationRegion: anchor.region || ('destinationRegion' in submitted ? submitted.destinationRegion : null), destinationCountry: anchor.country, destinationCountryCode: anchor.countryCode, latitude: anchor.latitude, longitude: anchor.longitude };
}

function tripCurrency(value: unknown): CurrencyCode {
  try {
    return normalizeCurrency(value ?? "PHP");
  } catch (error) {
    fail(error instanceof Error ? error.message : "Trip currency is invalid.");
  }
}

function tripParty(value: unknown, travelers: number): PartyType {
  const partyType = value === "solo" || value === "couple" || value === "family" || value === "friends" ? value : undefined;
  if (!partyType) fail("Trip party type is invalid.");
  try {
    if (travelersForParty(partyType, travelers) !== travelers) fail("Trip party type does not match the traveler count.");
  } catch (error) {
    fail(error instanceof Error ? error.message : "Trip party type is invalid.");
  }
  return partyType;
}

function destinationContext(value: unknown) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Destination details must be structured data.');
  const details = value as Record<string, unknown>;
  const city = String(details.city || '').trim().slice(0, 200);
  const region = String(details.region || '').trim().slice(0, 1000);
  const country = String(details.country || '').trim().slice(0, 100);
  const countryCode = String(details.countryCode || '').trim().toUpperCase();
  const latitude = Number(details.latitude);
  const longitude = Number(details.longitude);
  if (!city || !country || !/^[A-Z]{2}$/.test(countryCode)) fail('Selected destination details are incomplete.');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    fail('Selected destination coordinates are invalid.');
  }
  return {
    destinationCity: city,
    destinationRegion: region || null,
    destinationCountry: country,
    destinationCountryCode: countryCode,
    latitude,
    longitude,
  };
}





function serializeTrip(row: PrismaTrip) {
  const { saveKey: _key, saveRequestHash: _hash, ...publicTrip } = row;
  return {
    ...publicTrip,
    budget: Number(row.budget),
    latitude: row.latitude == null ? undefined : Number(row.latitude),
    longitude: row.longitude == null ? undefined : Number(row.longitude),
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    interests: Array.isArray(row.interests) ? row.interests.map(String) : [],
    archivedAt: row.archivedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createItineraryVersion(transaction: Transaction, trip: PrismaTrip, kind: "saved" | "regenerated" | "manual_edit" | "restored") {
  await transaction.$queryRaw`SELECT "id" FROM "trips" WHERE "id" = ${trip.id} FOR UPDATE`;
  const latest = await transaction.itineraryVersion.aggregate({ where: { tripId: trip.id }, _max: { version: true } });
  return transaction.itineraryVersion.create({
    data: {
      tripId: trip.id,
      version: (latest._max.version || 0) + 1,
      kind,
      itinerary: createVersionSnapshot(trip) as Prisma.InputJsonValue,
      weather: trip.weather == null ? Prisma.DbNull : trip.weather as Prisma.InputJsonValue,
    },
  });
}

async function audit(transaction: Transaction, actorId: string, action: string, targetId: string): Promise<void> {
  await transaction.auditEvent.create({ data: { actorId, action, targetId } });
}

async function saveTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const { key, hash } = saveIdentity(body);
  const replay = async () => {
    const existing = await prisma.trip.findUnique({ where: { userId_saveKey: { userId: user.id, saveKey: key } } });
    if (existing && existing.saveRequestHash !== hash) fail('This save request key was already used for a different plan.');
    return existing ? serializeTrip(existing) : null;
  };
  const previous = await replay();
  if (previous) return previous;
  const destination = String(body.destination || "").trim().slice(0, 2000);
  if (destination.length < 2) fail("Destination is required.");
  const budget = positiveMoney(body.budget, "Budget");
  const currency = tripCurrency(body.currency);
  if (!hasValidCurrencyPrecision(budget, currency)) fail(`${currency} budgets must use ${ZERO_DECIMAL_CURRENCIES.includes(currency) ? "whole currency units" : "no more than two decimal places"}.`);
  const selectedDestination = destinationContext(body.destinationDetails);
  const travelers = wholeNumber(body.travelers, "Travelers", 1, 20);
  const partyType = tripParty(body.partyType, travelers);
  const startDate = dateOnly(body.startDate, "Start date");
  const endDate = dateOnly(body.endDate, "End date");
  const days = tripLength(startDate, endDate);
  try {
    splitBudget(budget, travelers, days);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Trip budget is invalid.");
  }
  const itinerary = itineraryInput(body.itinerary, days, currency, budget, travelers, partyType, startDate, destination);
  const weather = weatherInput(body.weather);
  const interests = stringList(body.interests);

  try { return await prisma.$transaction(async (transaction) => {
    const trip = await transaction.trip.create({
      data: {
        saveKey: key, saveRequestHash: hash,
        userId: user.id,
        destination,
        ...groundedDestination(itinerary, selectedDestination),
        budget,
        currency,
        startDate,
        endDate,
        travelers,
        partyType,
        interests,
        itinerary,
        weather,
      },
    });
    await createItineraryVersion(transaction, trip, "saved");
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await replay();
    if (!existing) throw error;
    return existing;
  }
}

async function updateTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  const destination = String(body.destination || "").trim().slice(0, 2000);
  if (destination.length < 2) fail("Destination is required.");
  const budget = positiveMoney(body.budget, "Budget");
  const currency = tripCurrency(body.currency);
  if (!hasValidCurrencyPrecision(budget, currency)) fail(`${currency} budgets must use ${ZERO_DECIMAL_CURRENCIES.includes(currency) ? "whole currency units" : "no more than two decimal places"}.`);
  const selectedDestination = destinationContext(body.destinationDetails);
  const travelers = wholeNumber(body.travelers, "Travelers", 1, 20);
  const partyType = tripParty(body.partyType, travelers);
  const startDate = dateOnly(body.startDate, "Start date");
  const endDate = dateOnly(body.endDate, "End date");
  const days = tripLength(startDate, endDate);
  const itinerary = itineraryInput(body.itinerary, days, currency, budget, travelers, partyType, startDate, destination);
  const weather = weatherInput(body.weather);
  const interests = stringList(body.interests);

  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id, status: "active" } });
    if (!existing) fail("Saved trip not found.");
    const withPhotos = retainStoredActivityPhotos(itinerary as unknown as ItineraryResponse, existing.itinerary as unknown as ItineraryResponse);
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: {
        destination,
        ...groundedDestination(itinerary, selectedDestination),
        budget,
        currency,
        startDate,
        endDate,
        travelers,
        partyType,
        interests,
        itinerary: withPhotos as unknown as Prisma.InputJsonValue,
        weather,
      },
    });
    await createItineraryVersion(transaction, trip, "regenerated");
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function updateTripItinerary(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id, status: "active" } });
    if (!existing) fail("Saved trip not found.");
    const days = tripLength(existing.startDate, existing.endDate);
    let itinerary: Prisma.InputJsonValue;
    try {
      const edited = applyManualItineraryChanges(existing.itinerary, body.itinerary, days, Number(existing.budget), existing.travelers, normalizeCurrency(existing.currency));
      itinerary = parseSavedItinerary(edited, { days, currency: normalizeCurrency(existing.currency), budget: Number(existing.budget), travelers: existing.travelers, partyType: existing.partyType, destination: existing.destination, startDate: existing.startDate.toISOString().slice(0, 10) }) as unknown as Prisma.InputJsonValue;
    } catch (error) {
      if (error instanceof ItineraryEditValidationError) fail(error.message);
      throw error;
    }
    const trip = await transaction.trip.update({ where: { id: existing.id }, data: { itinerary } });
    await createItineraryVersion(transaction, trip, "manual_edit");
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function deleteTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    await transaction.trip.delete({ where: { id: existing.id } });
    await audit(transaction, user.id, action, tripId);
    return { id: tripId };
  });
}

function dateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  for (let cursor = new Date(start); cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) dates.push(cursor);
  return dates;
}

async function setTripLifecycleStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "trips" WHERE "id" = ${tripId} AND "user_id" = ${user.id} FOR UPDATE`;
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    if (existing.status === "archived" && (action === "complete-trip" || action === "reopen-trip")) fail("Restore this archived trip first.");
    const completedAt = action === "complete-trip" ? existing.completedAt ?? new Date()
      : action === "reopen-trip" ? null : existing.completedAt;
    const archivedAt = action === "archive-trip" ? existing.archivedAt ?? new Date() : null;
    const status = action === "archive-trip" ? "archived" : completedAt ? "completed" : "active";
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: { status, archivedAt, completedAt },
    });
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function restoreItineraryVersion(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  const versionId = identifier(body.versionId);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    if (existing.status !== "active") fail("Reopen this trip before restoring an itinerary version.");
    const version = await transaction.itineraryVersion.findFirst({ where: { id: versionId, tripId: existing.id } });
    if (!version) fail("Itinerary version not found.");
    let restored: Prisma.TripUpdateInput;
    let legacy = false;
    try {
      const snapshot = readVersionSnapshot(version.itinerary);
      const context = snapshot.context;
      const startDate = dateOnly(context.startDate, 'Snapshot start date');
      const endDate = dateOnly(context.endDate, 'Snapshot end date');
      const days = tripLength(startDate, endDate);
      const currency = tripCurrency(context.currency);
      if (!hasValidCurrencyPrecision(context.budget, currency)) fail('Snapshot budget has invalid currency precision.');
      const partyType = tripParty(context.partyType, context.travelers);
      const itinerary = parseSavedItinerary(snapshot.itinerary, { ...context, days, currency, partyType });
      const weather = parseSavedWeather(version.weather);
      restored = { ...context, startDate, endDate, itinerary: itinerary as unknown as Prisma.InputJsonValue, weather: weather == null ? Prisma.DbNull : weather as Prisma.InputJsonValue };
      legacy = snapshot.legacy;
    } catch (error) {
      fail(error instanceof Error ? `That itinerary version cannot be restored: ${error.message}` : "That itinerary version is invalid.");
    }
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: restored,
    });
    await createItineraryVersion(transaction, trip, "restored");
    await audit(transaction, user.id, action, trip.id);
    return { ...serializeTrip(trip), legacyContextRecovered: legacy };
  });
}

async function readNotification(user: PublicUser, action: string, body: Body) {
  if (action === "mark-all-notifications-read") {
    await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    if (user.role === 'admin') publishReportChange();
    return { all: true };
  }
  const id = identifier(body.id);
  const result = await prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
  if (!result.count) fail("Notification not found.");
  if (user.role === 'admin') publishReportChange();
  return { id };
}

async function adminUserStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const targetId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const target = await transaction.user.findFirst({ where: { id: targetId, role: { not: "admin" } } });
    if (!target) fail("Managed user not found.");
    const updated = await transaction.user.update({ where: { id: target.id }, data: { accountStatus: body.status === "suspended" ? "suspended" : "active" } });
    if (updated.accountStatus !== target.accountStatus) {
      const suspended = updated.accountStatus === 'suspended';
      await transaction.notification.create({ data: { userId: target.id, title: suspended ? 'Account suspended — you can appeal' : 'Account access restored', body: suspended ? 'Your TravelMate account has been suspended. You can sign in to view your account notices and submit an appeal for admin review. Your saved trips are preserved.' : 'An admin restored your account access. You can use TravelMate again.', href: suspended ? '/account/appeal' : '/dashboard' } });
      if (!suspended) await transaction.moderation.updateMany({ where: { kind: 'appeal', subjectId: target.id, status: 'pending' }, data: { status: 'approved' } });
    }
    await audit(transaction, user.id, action, target.id);
    return publicUser(updated);
  });
}

export async function executePlatformAction(user: PublicUser, action: string, body: Body): Promise<unknown> {
  if (action === 'duplicate-trip') fail('Trip duplication is no longer available.');
  if (['book', 'request-change', 'request-cancel', 'create-listing', 'update-listing', 'delete-listing', 'owner-request-decision', 'admin-booking-decision', 'release-payment', 'block-date', 'unblock-date', 'create-promotion', 'delete-promotion', 'submit-review', 'view-listing', 'submit-profile', 'moderate', 'resolve-dispute', 'admin-trust-score', 'admin-listing-status', 'admin-payment-status', 'submit-owner-document'].includes(action)) {
    fail('This workflow is no longer available.');
  }
  switch (action) {
    case 'record-visit': return recordVisit(user, body);
    case 'record-trip-visits': return recordTripVisits(user, body);
    case 'remove-visit': return removeVisit(user, body);
    case 'submit-report': return submitReport(user, body);
    case 'resolve-report': return resolveReport(user, body);
    case "save-trip": return saveTrip(user, action, body);
    case "update-trip": return updateTrip(user, action, body);
    case "update-trip-itinerary": return updateTripItinerary(user, action, body);
    case "delete-trip": return deleteTrip(user, action, body);
    case "archive-trip":
    case "restore-trip":
    case "complete-trip":
    case "reopen-trip": return setTripLifecycleStatus(user, action, body);
    case "restore-itinerary-version": return restoreItineraryVersion(user, action, body);
    case "mark-notification-read":
    case "mark-all-notifications-read": return readNotification(user, action, body);
    case "admin-user-status": return adminUserStatus(user, action, body);
    case 'admin-user-warning': return sendUserWarning(user, body);
    case 'review-appeal': return reviewAppeal(user, body);
    default: fail("Action is not allowed for this account.");
  }
}
