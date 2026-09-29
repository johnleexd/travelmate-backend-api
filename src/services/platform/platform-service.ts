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
import { applyManualItineraryChanges } from "../itinerary/itinerary-edit-service.ts";
import { parseSavedItinerary, parseSavedWeather } from "../itinerary/saved-trip-schema.ts";

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
  if (!Number.isInteger(days) || days < 1 || days > 14) fail("Trip dates must cover between 1 and 14 days.");
  return days;
}


function stringList(value: unknown, maximum = 20): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return items.map(String).map((item) => item.trim()).filter(Boolean).slice(0, maximum);
}

function itineraryInput(value: unknown, days: number, currency: CurrencyCode, budget: number, travelers: number, partyType: PartyType): Prisma.InputJsonValue {
  try {
    return parseSavedItinerary(value, { days, currency, budget, travelers, partyType }) as Prisma.InputJsonValue;
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
  const city = String(details.city || '').trim().slice(0, 100);
  const region = String(details.region || '').trim().slice(0, 100);
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
  return {
    ...row,
    budget: Number(row.budget),
    latitude: row.latitude == null ? undefined : Number(row.latitude),
    longitude: row.longitude == null ? undefined : Number(row.longitude),
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    interests: Array.isArray(row.interests) ? row.interests.map(String) : [],
    archivedAt: row.archivedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function createItineraryVersion(transaction: Transaction, trip: PrismaTrip, kind: "saved" | "regenerated" | "manual_edit" | "duplicated" | "restored") {
  await transaction.$queryRaw`SELECT "id" FROM "trips" WHERE "id" = ${trip.id} FOR UPDATE`;
  const latest = await transaction.itineraryVersion.aggregate({ where: { tripId: trip.id }, _max: { version: true } });
  return transaction.itineraryVersion.create({
    data: {
      tripId: trip.id,
      version: (latest._max.version || 0) + 1,
      kind,
      itinerary: trip.itinerary as Prisma.InputJsonValue,
      weather: trip.weather == null ? Prisma.DbNull : trip.weather as Prisma.InputJsonValue,
    },
  });
}

async function audit(transaction: Transaction, actorId: string, action: string, targetId: string): Promise<void> {
  await transaction.auditEvent.create({ data: { actorId, action, targetId } });
}

async function saveTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const destination = String(body.destination || "").trim().slice(0, 120);
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
  const itinerary = itineraryInput(body.itinerary, days, currency, budget, travelers, partyType);
  const weather = weatherInput(body.weather);
  const interests = stringList(body.interests);

  return prisma.$transaction(async (transaction) => {
    const trip = await transaction.trip.create({
      data: {
        userId: user.id,
        destination,
        ...selectedDestination,
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
}

async function updateTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  const destination = String(body.destination || "").trim().slice(0, 120);
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
  const itinerary = itineraryInput(body.itinerary, days, currency, budget, travelers, partyType);
  const weather = weatherInput(body.weather);
  const interests = stringList(body.interests);

  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id, status: "active" } });
    if (!existing) fail("Saved trip not found.");
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: {
        destination,
        ...selectedDestination,
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
      itinerary = parseSavedItinerary(edited, { days, currency: normalizeCurrency(existing.currency), budget: Number(existing.budget), travelers: existing.travelers, partyType: existing.partyType }) as Prisma.InputJsonValue;
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

async function duplicateTrip(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    const copy = await transaction.trip.create({
      data: {
        userId: user.id,
        destination: existing.destination,
        destinationCity: existing.destinationCity,
        destinationRegion: existing.destinationRegion,
        destinationCountry: existing.destinationCountry,
        destinationCountryCode: existing.destinationCountryCode,
        latitude: existing.latitude,
        longitude: existing.longitude,
        budget: existing.budget,
        currency: existing.currency,
        startDate: existing.startDate,
        endDate: existing.endDate,
        travelers: existing.travelers,
        partyType: existing.partyType,
        interests: existing.interests as Prisma.InputJsonValue,
        itinerary: existing.itinerary as Prisma.InputJsonValue,
        weather: existing.weather == null ? Prisma.DbNull : existing.weather as Prisma.InputJsonValue,
      },
    });
    await createItineraryVersion(transaction, copy, "duplicated");
    await audit(transaction, user.id, action, copy.id);
    return serializeTrip(copy);
  });
}


function dateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  for (let cursor = new Date(start); cursor < end; cursor = new Date(cursor.getTime() + 86_400_000)) dates.push(cursor);
  return dates;
}

async function setTripArchiveStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const tripId = identifier(body.id);
  const archive = action === "archive-trip";
  return prisma.$transaction(async (transaction) => {
    const existing = await transaction.trip.findFirst({ where: { id: tripId, userId: user.id } });
    if (!existing) fail("Saved trip not found.");
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: { status: archive ? "archived" : "active", archivedAt: archive ? new Date() : null },
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
    const version = await transaction.itineraryVersion.findFirst({ where: { id: versionId, tripId: existing.id } });
    if (!version) fail("Itinerary version not found.");
    const days = tripLength(existing.startDate, existing.endDate);
    try {
      parseSavedItinerary(version.itinerary, { days, currency: normalizeCurrency(existing.currency), budget: Number(existing.budget), travelers: existing.travelers, partyType: existing.partyType });
      parseSavedWeather(version.weather);
    } catch (error) {
      fail(error instanceof Error ? `That itinerary version cannot be restored: ${error.message}` : "That itinerary version is invalid.");
    }
    const trip = await transaction.trip.update({
      where: { id: existing.id },
      data: { itinerary: version.itinerary as Prisma.InputJsonValue, weather: version.weather == null ? Prisma.DbNull : version.weather as Prisma.InputJsonValue },
    });
    await createItineraryVersion(transaction, trip, "restored");
    await audit(transaction, user.id, action, trip.id);
    return serializeTrip(trip);
  });
}

async function readNotification(user: PublicUser, action: string, body: Body) {
  if (action === "mark-all-notifications-read") {
    await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { all: true };
  }
  const id = identifier(body.id);
  const result = await prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
  if (!result.count) fail("Notification not found.");
  return { id };
}

async function adminUserStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const targetId = identifier(body.id);
  return prisma.$transaction(async (transaction) => {
    const target = await transaction.user.findFirst({ where: { id: targetId, role: { not: "admin" } } });
    if (!target) fail("Managed user not found.");
    const updated = await transaction.user.update({ where: { id: target.id }, data: { accountStatus: body.status === "suspended" ? "suspended" : "active" } });
    await audit(transaction, user.id, action, target.id);
    return publicUser(updated);
  });
}

export async function executePlatformAction(user: PublicUser, action: string, body: Body): Promise<unknown> {
  if (['book', 'request-change', 'request-cancel', 'create-listing', 'update-listing', 'delete-listing', 'owner-request-decision', 'admin-booking-decision', 'release-payment', 'block-date', 'unblock-date', 'create-promotion', 'delete-promotion', 'submit-review', 'view-listing', 'submit-profile', 'moderate', 'resolve-dispute', 'admin-trust-score', 'admin-listing-status', 'admin-payment-status', 'submit-owner-document'].includes(action)) {
    fail('This workflow is no longer available.');
  }
  switch (action) {
    case 'submit-report': return submitReport(user, body);
    case 'resolve-report': return resolveReport(user, body);
    case "save-trip": return saveTrip(user, action, body);
    case "update-trip": return updateTrip(user, action, body);
    case "update-trip-itinerary": return updateTripItinerary(user, action, body);
    case "delete-trip": return deleteTrip(user, action, body);
    case "duplicate-trip": return duplicateTrip(user, action, body);
    case "archive-trip":
    case "restore-trip": return setTripArchiveStatus(user, action, body);
    case "restore-itinerary-version": return restoreItineraryVersion(user, action, body);
    case "mark-notification-read":
    case "mark-all-notifications-read": return readNotification(user, action, body);
    case "admin-user-status": return adminUserStatus(user, action, body);
    case 'admin-user-warning': return sendUserWarning(user, body);
    default: fail("Action is not allowed for this account.");
  }
}
