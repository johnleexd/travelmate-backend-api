import {
  Prisma,
  type Booking as PrismaBooking,
  type Listing as PrismaListing,
  type Moderation as PrismaModeration,
  type Trip as PrismaTrip,
} from "../../generated/prisma/client.ts";
import {
  ItineraryEditValidationError,
  PlatformActionError,
} from "../../exceptions/index.ts";
import { hasValidCurrencyPrecision, normalizeCurrency, publicUser, splitBudget, travelersForParty, ZERO_DECIMAL_CURRENCIES, type CurrencyCode, type PartyType, type PaymentStatus, type PublicUser } from "../../schemas/domain.ts";
import { isCebuLocation } from "../../constants/cebu-locations.ts";
import { prisma } from "../../lib/prisma.ts";
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

function listingCategory(value: unknown): "stay" | "activity" | "food" | "transport" {
  if (value === "stay" || value === "food" || value === "transport") return value;
  return "activity";
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

function imageList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(String).map((item) => item.trim()).filter((item) => item.length <= 1_500_000 && (/^https:\/\/(images\.unsplash\.com|upload\.wikimedia\.org|thumb\.wikimedia\.org|flagcdn\.com)\//.test(item) || item.startsWith('/') || item.startsWith('data:image/'))).slice(0, 8);
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

function paymentStatus(value: unknown): PaymentStatus {
  if (value === "PENDING" || value === "PAID_HELD" || value === "Released" || value === "FROZEN_HELD" || value === "REFUNDED") return value;
  fail("Booking or payment status is invalid.");
}

function serializeListing(row: PrismaListing) {
  return {
    ...row,
    price: Number(row.price),
    amenities: Array.isArray(row.amenities) ? row.amenities.map(String) : [],
    imageUrl: row.imageUrl ?? undefined,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls.map(String) : [],
  };
}

function serializeBooking(row: PrismaBooking) {
  return { ...row, amount: Number(row.amount), checkIn: row.checkIn?.toISOString().slice(0, 10), checkOut: row.checkOut?.toISOString().slice(0, 10), requestedCheckIn: row.requestedCheckIn?.toISOString().slice(0, 10), requestedCheckOut: row.requestedCheckOut?.toISOString().slice(0, 10), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function serializeModeration(row: PrismaModeration) {
  return { ...row, createdAt: row.createdAt.toISOString() };
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

async function submitProfile(user: PublicUser, action: string, body: Body) {
  const phone = String(body.phone || "").trim().slice(0, 30);
  const bio = String(body.bio || "").trim().slice(0, 500);
  if (!phone || !bio) fail("Phone and verification details are required.");

  return prisma.$transaction(async (transaction) => {
    const pending = await transaction.moderation.findFirst({ where: { kind: "profile", subjectId: user.id, status: "pending" } });
    if (pending) fail("Your profile verification is already pending review.");
    await transaction.user.update({ where: { id: user.id }, data: { profileStatus: "pending", phone, bio } });
    const item = await transaction.moderation.create({
      data: {
        kind: "profile",
        subjectId: user.id,
        title: `${user.name} profile verification`,
        details: `Phone: ${phone}; ${bio}`,
        status: "pending",
      },
    });
    await audit(transaction, user.id, action, item.id);
    return serializeModeration(item);
  });
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

async function notify(transaction: Transaction, userId: string, title: string, body: string, href = "") {
  return transaction.notification.create({ data: { userId, title: title.slice(0, 120), body: body.slice(0, 500), href: href.slice(0, 200) } });
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

async function bookListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  if (user.profileStatus !== "verified") fail("Limited Mode: complete profile verification before booking.");
  const listingId = identifier(body.listingId);
  const guests = wholeNumber(body.guests ?? 1, "Guests", 1, 20);
  const nights = wholeNumber(body.nights ?? 7, "Nights", 1, 30);
  const fallbackCheckIn = new Date();
  fallbackCheckIn.setUTCHours(0, 0, 0, 0);
  const checkIn = body.checkIn ? dateOnly(body.checkIn, "Check-in") : fallbackCheckIn;
  const checkOut = body.checkOut ? dateOnly(body.checkOut, "Check-out") : new Date(checkIn.getTime() + nights * 86_400_000);
  if (checkOut <= checkIn || Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000) !== nights) fail("Check-out must match the requested stay length.");

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, status: "approved" }, include: { promotions: { where: { active: true, startDate: { lte: checkIn }, endDate: { gte: checkIn } }, take: 1 } } });
    if (listing && listing.category !== "stay") fail("Only hotel, inn, and other stay listings can be booked.");
    if (!listing) fail("Listing, stay length, or capacity unavailable.");

    if (listing.available < guests) fail("Listing, stay length, or capacity unavailable.");
    const blocked = await transaction.listingBlockedDate.count({ where: { listingId, date: { in: dateRange(checkIn, checkOut) } } });
    if (blocked) fail("One or more requested dates are blocked by the owner.");
    const overlapping = await transaction.booking.aggregate({
      where: { listingId, status: { in: ["confirmed", "change_requested", "cancel_requested"] }, checkIn: { lt: checkOut }, checkOut: { gt: checkIn } },
      _sum: { guests: true },
    });
    if ((overlapping._sum.guests || 0) + guests > listing.capacity) fail("The listing does not have enough capacity for those dates.");
    const discount = listing.promotions[0]?.discountPct || 0;
    const amount = Math.round(Number(listing.price) * nights * (100 - discount)) / 100;

    const booking = await transaction.booking.create({
      data: {
        travelerId: user.id,
        listingId: listing.id,
        amount,
        guests,
        nights,
        status: "pending",
        paymentStatus: "PENDING",
        checkIn,
        checkOut,
        notes: String(body.notes || "").trim().slice(0, 500),
      },
    });
    await notify(transaction, listing.ownerId, "New booking request", `${user.name} requested ${nights} night${nights === 1 ? "" : "s"} at ${listing.name}.`, "/owner/dashboard?tab=bookings");
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(booking);
  });
}

async function requestBookingReview(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({ where: { id: bookingId, travelerId: user.id }, include: { listing: true } });
    if (!booking) fail("Booking not found.");
    if (booking.status !== "confirmed") fail("This booking already has a pending request or is no longer active.");
    const requestedCheckIn = action === "request-change" && body.checkIn ? dateOnly(body.checkIn, "Requested check-in") : booking.checkIn;
    const requestedCheckOut = action === "request-change" && body.checkOut ? dateOnly(body.checkOut, "Requested check-out") : booking.checkOut;
    const requestedGuests = action === "request-change" ? wholeNumber(body.guests ?? booking.guests, "Requested guests", 1, 20) : null;
    if (action === "request-change" && requestedCheckIn && requestedCheckOut && requestedCheckOut <= requestedCheckIn) fail("Requested check-out must be after check-in.");
    const requestNote = String(body.reason || "Traveler requested review.").trim().slice(0, 500);
    const updated = await transaction.booking.update({
      where: { id: booking.id },
      data: { status: action === "request-cancel" ? "cancel_requested" : "change_requested", paymentStatus: "FROZEN_HELD", requestedCheckIn, requestedCheckOut, requestedGuests, requestNote },
    });
    await transaction.moderation.create({
      data: {
        kind: "dispute",
        subjectId: booking.id,
        title: `Booking ${booking.id} request`,
        details: requestNote,
        status: "pending",
      },
    });
    await notify(transaction, booking.listing.ownerId, action === "request-cancel" ? "Cancellation requested" : "Booking change requested", `${user.name} requested a review for ${booking.listing.name}.`, "/owner/dashboard?tab=bookings");
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

async function createListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  if (user.profileStatus !== "verified") fail("Verify your profile before publishing listings.");
  const capacity = wholeNumber(body.capacity, "Capacity", 1, 100000);
  const price = positiveMoney(body.price, "Price");
  const name = String(body.name || "").trim().slice(0, 100);
  const municipality = String(body.municipality || "");
  if (!name || !isCebuLocation(municipality)) fail("Valid listing name, Cebu location, price, and capacity are required.");
  const images = imageList(body.imageUrls ?? body.imageUrl);

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.create({
      data: {
        ownerId: user.id,
        name,
        category: listingCategory(body.category),
        price,
        capacity,
        available: capacity,
        status: "pending",
        description: String(body.description || "").trim().slice(0, 1000),
        municipality,
        address: String(body.address || "").trim().slice(0, 300),
        amenities: stringList(body.amenities),
        imageUrl: images[0] || null,
        imageUrls: images,
      },
    });
    await transaction.moderation.create({
      data: { kind: "listing", subjectId: listing.id, title: `Review ${listing.name}`, details: `PHP ${price}; capacity ${capacity}`, status: "pending" },
    });
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(listing);
  });
}

async function updateListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const listingId = identifier(body.id);
  const capacity = wholeNumber(body.capacity, "Capacity", 1, 100000);
  const price = positiveMoney(body.price, "Price");
  const name = String(body.name || "").trim().slice(0, 100);
  const municipality = String(body.municipality || "");
  const images = imageList(body.imageUrls ?? body.imageUrl);

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
    if (!listing) fail("Listing not found.");
    const bookedSlots = listing.capacity - listing.available;
    if (!name || !isCebuLocation(municipality) || capacity < Math.max(1, bookedSlots)) {
      fail("Provide a valid Cebu location; capacity cannot be lower than booked slots.");
    }

    const updated = await transaction.listing.update({
      where: { id: listing.id },
      data: {
        name,
        price,
        capacity,
        available: capacity - bookedSlots,
        category: body.category === undefined ? listing.category : listingCategory(body.category),
        municipality,
        description: String(body.description || "").trim().slice(0, 1000),
        address: String(body.address || "").trim().slice(0, 300),
        amenities: stringList(body.amenities),
        imageUrl: images[0] || null,
        imageUrls: images,
        status: "pending",
      },
    });
    const pending = await transaction.moderation.count({ where: { kind: "listing", subjectId: listing.id, status: "pending" } });
    if (!pending) {
      await transaction.moderation.create({
        data: { kind: "listing", subjectId: listing.id, title: `Review updated ${name}`, details: `PHP ${price}; capacity ${capacity}`, status: "pending" },
      });
    }
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(updated);
  });
}

async function deleteListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const listingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
    if (!listing) fail("Listing not found.");
    if (await transaction.booking.count({ where: { listingId } })) fail("Listings with booking history cannot be deleted.");
    await transaction.moderation.deleteMany({ where: { subjectId: listingId } });
    await transaction.listing.delete({ where: { id: listingId } });
    await audit(transaction, user.id, action, listingId);
    return { id: listingId };
  });
}

async function ownerBookingDecision(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({
      where: { id: bookingId, listing: { ownerId: user.id } },
      include: { listing: true },
    });
    if (!booking || !["pending", "cancel_requested", "change_requested"].includes(booking.status)) {
      fail("Pending booking request not found.");
    }
    const approve = body.decision === "approve";
    let status: "declined" | "cancelled" | "confirmed" = booking.status === "pending" && !approve ? "declined" : "confirmed";
    let nextPaymentStatus: "PENDING" | "REFUNDED" | "PAID_HELD" = booking.status === "pending" && !approve ? "PENDING" : "PAID_HELD";
    if (booking.status === "pending" && approve) {
      const capacity = await transaction.listing.updateMany({ where: { id: booking.listingId, available: { gte: booking.guests } }, data: { available: { decrement: booking.guests } } });
      if (capacity.count !== 1) fail("This listing no longer has enough capacity.");
      await transaction.paymentTransaction.create({ data: { bookingId: booking.id, kind: "authorization", status: "held", amount: booking.amount, note: "Simulated payment hold after owner approval." } });
    }
    if (booking.status === "cancel_requested" && approve) {
      status = "cancelled";
      nextPaymentStatus = "REFUNDED";
      await transaction.listing.update({
        where: { id: booking.listingId },
        data: { available: Math.min(booking.listing.capacity, booking.listing.available + booking.guests) },
      });
      await transaction.paymentTransaction.create({ data: { bookingId: booking.id, kind: "refund", status: "refunded", amount: booking.amount, note: "Simulated refund after approved cancellation." } });
    }
    let approvedChange: { checkIn: Date; checkOut: Date; guests: number; nights: number; amount: number } | undefined;
    if (booking.status === "change_requested" && approve) {
      const nextCheckIn = booking.requestedCheckIn || booking.checkIn;
      const nextCheckOut = booking.requestedCheckOut || booking.checkOut;
      const nextGuests = booking.requestedGuests || booking.guests;
      if (!nextCheckIn || !nextCheckOut) fail("The requested stay dates are incomplete.");
      const blocked = await transaction.listingBlockedDate.count({ where: { listingId: booking.listingId, date: { in: dateRange(nextCheckIn, nextCheckOut) } } });
      const overlapping = await transaction.booking.aggregate({ where: { id: { not: booking.id }, listingId: booking.listingId, status: { in: ["confirmed", "change_requested", "cancel_requested"] }, checkIn: { lt: nextCheckOut }, checkOut: { gt: nextCheckIn } }, _sum: { guests: true } });
      if (blocked || (overlapping._sum.guests || 0) + nextGuests > booking.listing.capacity) fail("The requested date or capacity is no longer available.");
      const guestDelta = nextGuests - booking.guests;
      if (guestDelta > 0) {
        const capacity = await transaction.listing.updateMany({ where: { id: booking.listingId, available: { gte: guestDelta } }, data: { available: { decrement: guestDelta } } });
        if (capacity.count !== 1) fail("The listing does not have enough remaining capacity.");
      } else if (guestDelta < 0) {
        await transaction.listing.update({ where: { id: booking.listingId }, data: { available: { increment: Math.abs(guestDelta) } } });
      }
      const changedNights = Math.round((nextCheckOut.getTime() - nextCheckIn.getTime()) / 86_400_000);
      approvedChange = { checkIn: nextCheckIn, checkOut: nextCheckOut, guests: nextGuests, nights: changedNights, amount: Math.round(Number(booking.listing.price) * changedNights * 100) / 100 };
    }
    const updated = await transaction.booking.update({ where: { id: booking.id }, data: { status, paymentStatus: nextPaymentStatus, ...(approvedChange || {}), requestedCheckIn: null, requestedCheckOut: null, requestedGuests: null, requestNote: "" } });
    await transaction.moderation.updateMany({ where: { kind: "dispute", subjectId: booking.id, status: "pending" }, data: { status: "resolved" } });
    await audit(transaction, user.id, action, booking.id);
    await notify(transaction, booking.travelerId, status === "confirmed" ? "Booking confirmed" : status === "declined" ? "Booking request declined" : "Cancellation approved", `${booking.listing.name}: ${status.replaceAll("_", " ")}.`, "/dashboard?tab=bookings");
    return serializeBooking(updated);
  });
}

async function releasePayment(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const bookingId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({ where: { id: bookingId, paymentStatus: "PAID_HELD", listing: { ownerId: user.id } }, include: { listing: true } });
    if (!booking) fail("Held payment not found.");
    const updated = await transaction.booking.update({ where: { id: booking.id }, data: { paymentStatus: "Released", status: "completed" } });
    await transaction.paymentTransaction.create({ data: { bookingId: booking.id, kind: "payout", status: "released", amount: booking.amount, note: "Simulated owner payout." } });
    await notify(transaction, booking.travelerId, "Stay completed", `${booking.listing.name} is marked complete. You can now leave a review.`, "/dashboard?tab=bookings");
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

async function setBlockedDate(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const listingId = identifier(body.listingId);
  const date = dateOnly(body.date, "Blocked date");
  const listing = await prisma.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
  if (!listing) fail("Listing not found.");
  if (action === "unblock-date") {
    await prisma.listingBlockedDate.deleteMany({ where: { listingId, date } });
    return { listingId, date: date.toISOString().slice(0, 10) };
  }
  return prisma.listingBlockedDate.upsert({ where: { listingId_date: { listingId, date } }, create: { listingId, date, reason: String(body.reason || "Owner unavailable").slice(0, 200) }, update: { reason: String(body.reason || "Owner unavailable").slice(0, 200) } });
}

async function managePromotion(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  if (action === "delete-promotion") {
    const id = identifier(body.id);
    const promotion = await prisma.promotion.findFirst({ where: { id, listing: { ownerId: user.id } } });
    if (!promotion) fail("Promotion not found.");
    await prisma.promotion.delete({ where: { id } });
    return { id };
  }
  const listingId = identifier(body.listingId);
  const listing = await prisma.listing.findFirst({ where: { id: listingId, ownerId: user.id } });
  if (!listing) fail("Listing not found.");
  const name = String(body.name || "Seasonal offer").trim().slice(0, 80);
  const discountPct = wholeNumber(body.discountPct, "Discount", 1, 90);
  const startDate = dateOnly(body.startDate, "Promotion start");
  const endDate = dateOnly(body.endDate, "Promotion end");
  if (endDate < startDate) fail("Promotion end must be on or after its start date.");
  return prisma.promotion.create({ data: { listingId, name, discountPct, startDate, endDate } });
}

async function submitReview(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const bookingId = identifier(body.bookingId);
  const rating = wholeNumber(body.rating, "Rating", 1, 5);
  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findFirst({ where: { id: bookingId, travelerId: user.id, status: "completed" }, include: { listing: true } });
    if (!booking) fail("Only completed stays can be reviewed.");
    if (await transaction.review.count({ where: { bookingId } })) fail("This booking already has a review.");
    const review = await transaction.review.create({ data: { bookingId, listingId: booking.listingId, travelerId: user.id, rating, comment: String(body.comment || "").trim().slice(0, 1000) } });
    await notify(transaction, booking.listing.ownerId, "New traveler review", `${user.name} rated ${booking.listing.name} ${rating}/5.`, "/owner/dashboard?tab=reviews");
    await audit(transaction, user.id, action, review.id);
    return { ...review, createdAt: review.createdAt.toISOString() };
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

async function submitOwnerDocument(user: PublicUser, action: string, body: Body) {
  requireRole(user, "owner");
  const type = String(body.type || "business_permit").trim().slice(0, 60);
  const name = String(body.name || "Verification document").trim().slice(0, 120);
  const fileUrl = String(body.fileUrl || "").trim();
  if (!fileUrl || fileUrl.length > 2_000_000 || !(fileUrl.startsWith("data:") || fileUrl.startsWith("https://"))) fail("Provide a valid document file or HTTPS URL under 2 MB.");
  return prisma.$transaction(async (transaction) => {
    const document = await transaction.ownerDocument.create({ data: { ownerId: user.id, type, name, fileUrl } });
    const pending = await transaction.moderation.count({ where: { kind: "profile", subjectId: user.id, status: "pending" } });
    if (!pending) await transaction.moderation.create({ data: { kind: "profile", subjectId: user.id, title: `${user.name} submitted ${name}`, details: `Owner document: ${type}`, status: "pending" } });
    await audit(transaction, user.id, action, document.id);
    return { ...document, fileUrl: "submitted", createdAt: document.createdAt.toISOString() };
  });
}

async function viewListing(user: PublicUser, action: string, body: Body) {
  requireRole(user, "traveler");
  const id = identifier(body.id);
  const listing = await prisma.listing.updateMany({ where: { id, status: "approved" }, data: { viewCount: { increment: 1 } } });
  if (!listing.count) fail("Listing not found.");
  return { id };
}

async function moderate(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const moderationId = identifier(body.id);

  return prisma.$transaction(async (transaction) => {
    const item = await transaction.moderation.findFirst({ where: { id: moderationId, status: "pending" } });
    if (!item) fail("Queue item not found.");
    const approve = body.decision === "approve" || body.decision === "traveler";
    const updated = await transaction.moderation.update({
      where: { id: item.id },
      data: { status: item.kind === "dispute" ? "resolved" : approve ? "approved" : "rejected" },
    });

    if (item.kind === "profile") {
      const target = await transaction.user.findUnique({ where: { id: item.subjectId } });
      if (target) {
        await transaction.user.update({
          where: { id: target.id },
          data: { profileStatus: approve ? "verified" : "rejected", trustScore: Math.max(0, Math.min(100, target.trustScore + (approve ? 10 : -10))) },
        });
        await transaction.ownerDocument.updateMany({ where: { ownerId: target.id, status: "pending" }, data: { status: approve ? "approved" : "rejected" } });
        await notify(transaction, target.id, approve ? "Profile verified" : "Verification needs attention", approve ? "Your owner profile and submitted documents were approved." : "Your verification submission was not approved. Review your details and submit again.", target.role === "owner" ? "/owner/dashboard?tab=profile" : "/dashboard?tab=profile");
      }
    }
    if (item.kind === "listing") {
      const listing = await transaction.listing.findUnique({ where: { id: item.subjectId } });
      if (listing) {
        await transaction.listing.update({ where: { id: listing.id }, data: { status: approve ? "approved" : "rejected" } });
        await notify(transaction, listing.ownerId, approve ? "Listing approved" : "Listing needs revision", `${listing.name} was ${approve ? "approved and is now visible to travelers" : "not approved"}.`, "/owner/dashboard?tab=listings");
      }
    }
    if (item.kind === "dispute") {
      const booking = await transaction.booking.findUnique({ where: { id: item.subjectId } });
      if (booking) {
        if (approve && booking.status !== "cancelled") {
          const listing = await transaction.listing.findUnique({ where: { id: booking.listingId } });
          if (listing) {
            await transaction.listing.update({
              where: { id: listing.id },
              data: { available: Math.min(listing.capacity, listing.available + booking.guests) },
            });
          }
        }
        await transaction.booking.update({
          where: { id: booking.id },
          data: { status: approve ? "cancelled" : "confirmed", paymentStatus: approve ? "REFUNDED" : "PAID_HELD" },
        });
      }
    }
    await audit(transaction, user.id, action, item.id);
    return serializeModeration(updated);
  });
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

async function adminTrustScore(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const targetId = identifier(body.id);
  const score = wholeNumber(body.score, "Trust score", 0, 100);
  return prisma.$transaction(async (transaction) => {
    const target = await transaction.user.findFirst({ where: { id: targetId, role: { not: "admin" } } });
    if (!target) fail("Managed user not found.");
    const updated = await transaction.user.update({ where: { id: target.id }, data: { trustScore: score } });
    await audit(transaction, user.id, action, target.id);
    return publicUser(updated);
  });
}

async function adminListingStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const listingId = identifier(body.id);
  const status = body.status;
  if (status !== "approved" && status !== "rejected" && status !== "pending") fail("Listing or status is invalid.");
  return prisma.$transaction(async (transaction) => {
    const listing = await transaction.listing.findUnique({ where: { id: listingId } });
    if (!listing) fail("Listing or status is invalid.");
    const updated = await transaction.listing.update({ where: { id: listing.id }, data: { status } });
    await audit(transaction, user.id, action, listing.id);
    return serializeListing(updated);
  });
}

async function adminPaymentStatus(user: PublicUser, action: string, body: Body) {
  requireRole(user, "admin");
  const bookingId = identifier(body.id);
  const status = paymentStatus(body.status);
  const allowedTransitions: Record<PaymentStatus, PaymentStatus[]> = {
    PENDING: ["PAID_HELD"],
    PAID_HELD: ["Released", "FROZEN_HELD", "REFUNDED"],
    FROZEN_HELD: ["PAID_HELD", "REFUNDED"],
    Released: [],
    REFUNDED: [],
  };

  return prisma.$transaction(async (transaction) => {
    const booking = await transaction.booking.findUnique({ where: { id: bookingId } });
    if (!booking) fail("Booking or payment status is invalid.");
    if (status !== booking.paymentStatus && !allowedTransitions[booking.paymentStatus].includes(status)) fail("That payment transition is not allowed.");
    if (status === "REFUNDED" && booking.status !== "cancelled") {
      const listing = await transaction.listing.findUnique({ where: { id: booking.listingId } });
      if (listing) {
        await transaction.listing.update({
          where: { id: listing.id },
          data: { available: Math.min(listing.capacity, listing.available + booking.guests) },
        });
      }
    }
    const updated = await transaction.booking.update({
      where: { id: booking.id },
      data: {
        paymentStatus: status,
        ...(status === "REFUNDED" ? { status: "cancelled" as const } : {}),
        ...(status === "Released" ? { status: "completed" as const } : {}),
      },
    });
    await audit(transaction, user.id, action, booking.id);
    return serializeBooking(updated);
  });
}

export async function executePlatformAction(user: PublicUser, action: string, body: Body): Promise<unknown> {
  switch (action) {
    case "submit-profile": return submitProfile(user, action, body);
    case "save-trip": return saveTrip(user, action, body);
    case "update-trip": return updateTrip(user, action, body);
    case "update-trip-itinerary": return updateTripItinerary(user, action, body);
    case "delete-trip": return deleteTrip(user, action, body);
    case "duplicate-trip": return duplicateTrip(user, action, body);
    case "archive-trip":
    case "restore-trip": return setTripArchiveStatus(user, action, body);
    case "restore-itinerary-version": return restoreItineraryVersion(user, action, body);
    case "book": return bookListing(user, action, body);
    case "request-cancel":
    case "request-change": return requestBookingReview(user, action, body);
    case "create-listing": return createListing(user, action, body);
    case "update-listing": return updateListing(user, action, body);
    case "delete-listing": return deleteListing(user, action, body);
    case "owner-request-decision": return ownerBookingDecision(user, action, body);
    case "release-payment": return releasePayment(user, action, body);
    case "block-date":
    case "unblock-date": return setBlockedDate(user, action, body);
    case "create-promotion":
    case "delete-promotion": return managePromotion(user, action, body);
    case "submit-review": return submitReview(user, action, body);
    case "mark-notification-read":
    case "mark-all-notifications-read": return readNotification(user, action, body);
    case "submit-owner-document": return submitOwnerDocument(user, action, body);
    case "view-listing": return viewListing(user, action, body);
    case "moderate":
    case "resolve-dispute": return moderate(user, action, body);
    case "admin-user-status": return adminUserStatus(user, action, body);
    case "admin-trust-score": return adminTrustScore(user, action, body);
    case "admin-listing-status": return adminListingStatus(user, action, body);
    case "admin-payment-status": return adminPaymentStatus(user, action, body);
    default: fail("Action is not allowed for this account.");
  }
}
