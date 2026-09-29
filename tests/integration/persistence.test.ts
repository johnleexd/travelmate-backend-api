import assert from "node:assert/strict";
import test from "node:test";
import { publicUser } from "../../src/schemas/domain.ts";
import { prisma } from "../../src/lib/prisma.ts";
import { authenticateUser } from "../../src/services/auth/auth-service.ts";
import { executePlatformAction } from "../../src/services/platform/platform-service.ts";
import * as authRoute from "../../src/controllers/auth-controller.ts";
import { beginGeneration, completeGeneration } from "../../src/controllers/itinerary-controller.ts";

async function tableCounts() {
  const [users, listings, bookings, moderation, trips, audit] = await Promise.all([
    prisma.user.count(),
    prisma.listing.count(),
    prisma.booking.count(),
    prisma.moderation.count(),
    prisma.trip.count(),
    prisma.auditEvent.count(),
  ]);
  return { users, listings, bookings, moderation, trips, audit };
}

test("seeded roles authenticate through targeted user queries", async () => {
  for (const role of ["traveler", "owner", "admin"] as const) {
    const user = await authenticateUser(`${role}@travelmate.test`, "Travel123!");
    assert.equal(user?.role, role);
    assert.equal(user && "passwordHash" in user, false);
  }
});

test("registration requires verification before login", async () => {
  const email = `registration-${Date.now()}@travelmate.test`;
  try {
    const registration = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `integration-${Date.now()}` },
      body: JSON.stringify({ action: "register", name: "Registration Test", email, password: "Travel123!", role: "traveler" }),
    }));
    assert.equal(registration.status, 201);
    const created = await registration.json() as { verificationCode: string };
    const blockedLogin = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `integration-login-${Date.now()}` },
      body: JSON.stringify({ action: "login", email, password: "Travel123!" }),
    }));
    assert.equal(blockedLogin.status, 403, "unverified user must not be granted application login");

    const verification = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `integration-verify-${Date.now()}` },
      body: JSON.stringify({ action: "verify-email", email, code: created.verificationCode }),
    }));
    assert.equal(verification.status, 200);
    const verifiedLogin = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `integration-verified-${Date.now()}` },
      body: JSON.stringify({ action: "login", email, password: "Travel123!" }),
    }));
    assert.equal(verifiedLogin.status, 200);
    const oldSession = verifiedLogin.headers.get("set-cookie");
    assert.ok(oldSession);

    const forgot = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "forgot-password", email }),
    }));
    assert.equal(forgot.status, 200);
    const recovery = await forgot.json() as { resetCode: string };
    assert.match(recovery.resetCode, /^[A-F0-9]{8}$/);

    const reset = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset-password", email, code: recovery.resetCode, password: "NewTravel123!" }),
    }));
    assert.equal(reset.status, 200);

    const expiredSession = await authRoute.GET(new Request("http://localhost:5000/api/auth", { headers: { Cookie: oldSession } }));
    assert.equal(expiredSession.status, 401, "password reset must invalidate existing sessions");

    const oldPasswordLogin = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email, password: "Travel123!" }),
    }));
    assert.equal(oldPasswordLogin.status, 401);

    const newPasswordLogin = await authRoute.POST(new Request("http://localhost:5000/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", email, password: "NewTravel123!" }),
    }));
    assert.equal(newPasswordLogin.status, 200);
  } finally {
    await prisma.user.deleteMany({ where: { email } });
  }
});

test("a trip write only changes the intended trip and audit rows", async () => {
  const traveler = await prisma.user.findUnique({ where: { email: "traveler@travelmate.test" } });
  assert.ok(traveler, "Run npm run db:seed before the integration test.");
  const before = await tableCounts();
  let tripId: string | undefined;

  try {
    const result = await executePlatformAction(publicUser(traveler), "save-trip", {
      destination: "Integration Test Destination",
      destinationDetails: { city: "Tokyo", region: "Tokyo", country: "Japan", countryCode: "JP", latitude: 35.6762, longitude: 139.6503 },
      budget: 10000,
      currency: "USD",
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      travelers: 1,
      interests: ["testing"],
      itinerary: { destination: "Integration Test Destination", totalBudget: 10000, currency: "USD", days: [{ day: 1, date: "2026-10-01", activities: [{ title: "Integration activity", estimatedCost: 100 }] }] },
      weather: {
        source: "unavailable",
        fetchedAt: "2026-09-15T00:00:00.000Z",
        refreshAfter: "2026-09-15T01:00:00.000Z",
        crowd: [{ date: "2026-10-01", crowdLevel: "low", crowdSource: "estimated", crowdConfidence: "low", fetchedAt: "2026-09-15T00:00:00.000Z", refreshAfter: "2026-09-16T00:00:00.000Z" }],
      },
    }) as { id: string; currency: string; destinationCity: string; destinationCountryCode: string; latitude: number; longitude: number; weather: { fetchedAt: string; crowd: Array<{ crowdLevel: string }> } };
    tripId = result.id;
    assert.equal(result.currency, "USD");
    assert.equal(result.destinationCity, "Tokyo");
    assert.equal(result.destinationCountryCode, "JP");
    assert.equal(result.latitude, 35.6762);
    assert.equal(result.longitude, 139.6503);
    assert.equal(result.weather.fetchedAt, "2026-09-15T00:00:00.000Z");
    assert.equal(result.weather.crowd[0].crowdLevel, "low");

    const after = await tableCounts();
    assert.equal(after.users, before.users);
    assert.equal(after.listings, before.listings);
    assert.equal(after.bookings, before.bookings);
    assert.equal(after.moderation, before.moderation);
    assert.equal(after.trips, before.trips + 1);
    assert.equal(after.audit, before.audit + 1);
  } finally {
    if (tripId) {
      await prisma.$transaction([
        prisma.auditEvent.deleteMany({ where: { targetId: tripId } }),
        prisma.trip.delete({ where: { id: tripId } }),
      ]);
    }
  }

  assert.deepEqual(await tableCounts(), before);
});

test("saved-trip CRUD enforces traveler ownership", async () => {
  const owner = await prisma.user.findUnique({ where: { email: "traveler@travelmate.test" } });
  assert.ok(owner, "Run npm run db:seed before the integration test.");
  const other = await prisma.user.create({
    data: {
      name: "Ownership Test Traveler",
      email: `ownership-${Date.now()}@travelmate.test`,
      role: "traveler",
      emailVerified: true,
      profileStatus: "verified",
      passwordHash: "test-only",
      passwordSalt: "test-only",
    },
  });
  const ids: string[] = [];

  try {
    const created = await executePlatformAction(publicUser(owner), "save-trip", {
      destination: "Ownership Test Destination",
      budget: 12000,
      currency: "PHP",
      startDate: "2026-10-10",
      endDate: "2026-10-11",
      travelers: 1,
      interests: ["security"],
      itinerary: { destination: "Ownership Test Destination", totalBudget: 12000, currency: "PHP", days: [{ day: 1, activities: [{ title: "Day one", estimatedCost: 100 }] }, { day: 2, activities: [{ title: "Day two", estimatedCost: 100 }] }] },
      weather: null,
    }) as { id: string };
    ids.push(created.id);
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId: created.id } }), 1);

    await assert.rejects(
      executePlatformAction(publicUser(other), "delete-trip", { id: created.id }),
      /Saved trip not found/,
    );

    const updated = await executePlatformAction(publicUser(owner), "update-trip", {
      id: created.id,
      destination: "Updated Ownership Destination",
      budget: 13000,
      currency: "EUR",
      startDate: "2026-10-10",
      endDate: "2026-10-11",
      travelers: 1,
      interests: ["security", "crud"],
      itinerary: { destination: "Updated Ownership Destination", totalBudget: 13000, currency: "EUR", days: [{ day: 1, activities: [{ title: "Day one", estimatedCost: 100 }] }, { day: 2, activities: [{ title: "Day two", estimatedCost: 100 }] }] },
      weather: null,
    }) as { destination: string; currency: string };
    assert.equal(updated.destination, "Updated Ownership Destination");
    assert.equal(updated.currency, "EUR");
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId: created.id } }), 2);

    await assert.rejects(
      executePlatformAction(publicUser(other), "update-trip-itinerary", {
        id: created.id,
        itinerary: { days: [] },
      }),
      /Saved trip not found/,
    );

    const manuallyEdited = await executePlatformAction(publicUser(owner), "update-trip-itinerary", {
      id: created.id,
      itinerary: {
        days: [
          { activities: [
            { time: "08:00", title: "Manual transfer", description: "Test transfer", category: "transport", estimatedCost: 250 },
            { time: "09:00", title: "Manual activity", description: "Test activity", category: "activity", estimatedCost: 300 },
          ] },
          { activities: [] },
        ],
      },
    }) as { itinerary: { manuallyEdited: boolean; days: Array<{ totalCost: number; rideFare: number; activities: unknown[] }>; budgetSummary: { plannedSpend: number } } };
    assert.equal(manuallyEdited.itinerary.manuallyEdited, true);
    assert.equal(manuallyEdited.itinerary.days[0].totalCost, 550);
    assert.equal(manuallyEdited.itinerary.days[0].rideFare, 250);
    assert.equal(manuallyEdited.itinerary.days[1].activities.length, 0);
    assert.equal(manuallyEdited.itinerary.budgetSummary.plannedSpend, 550);
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId: created.id } }), 3);

    await assert.rejects(
      executePlatformAction(publicUser(other), "archive-trip", { id: created.id }),
      /Saved trip not found/,
    );
    const archived = await executePlatformAction(publicUser(owner), "archive-trip", { id: created.id }) as { status: string; archivedAt?: string };
    assert.equal(archived.status, "archived");
    assert.ok(archived.archivedAt);
    const restoredTrip = await executePlatformAction(publicUser(owner), "restore-trip", { id: created.id }) as { status: string; archivedAt?: string };
    assert.equal(restoredTrip.status, "active");
    assert.equal(restoredTrip.archivedAt, undefined);

    const firstVersion = await prisma.itineraryVersion.findFirstOrThrow({ where: { tripId: created.id, version: 1 } });
    await executePlatformAction(publicUser(owner), "restore-itinerary-version", { id: created.id, versionId: firstVersion.id });
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId: created.id } }), 4);
    assert.equal((await prisma.itineraryVersion.findFirstOrThrow({ where: { tripId: created.id }, orderBy: { version: "desc" } })).kind, "restored");

    const duplicate = await executePlatformAction(publicUser(owner), "duplicate-trip", { id: created.id }) as { id: string; currency: string };
    ids.push(duplicate.id);
    assert.notEqual(duplicate.id, created.id);
    assert.equal(duplicate.currency, "EUR");
    assert.equal(await prisma.itineraryVersion.count({ where: { tripId: duplicate.id } }), 1);

    await executePlatformAction(publicUser(owner), "delete-trip", { id: duplicate.id });
    assert.equal(await prisma.trip.findUnique({ where: { id: duplicate.id } }), null);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ targetId: { in: ids } }, { actorId: other.id }] } });
    await prisma.trip.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.delete({ where: { id: other.id } });
  }
});

test("generation idempotency replays completed results and rejects key reuse", async () => {
  const traveler = await prisma.user.findUnique({ where: { email: "traveler@travelmate.test" } });
  assert.ok(traveler, "Run npm run db:seed before the integration test.");
  const key = `integration-${Date.now()}`;
  const body = { destination: "Tokyo", budget: 10000, startDate: "2026-10-01", endDate: "2026-10-02" };
  try {
    const started = await beginGeneration(traveler.id, "Tokyo", body, key);
    assert.ok("recordId" in started);
    if (!("recordId" in started)) return;
    await completeGeneration(started.recordId, { destination: "Tokyo", days: [] });

    const replay = await beginGeneration(traveler.id, "Tokyo", body, key);
    assert.ok("replay" in replay);
    assert.deepEqual("replay" in replay ? replay.replay : null, { destination: "Tokyo", days: [] });

    const conflict = await beginGeneration(traveler.id, "Osaka", { ...body, destination: "Osaka" }, key);
    assert.ok("conflict" in conflict);
  } finally {
    await prisma.itineraryGeneration.deleteMany({ where: { userId: traveler.id, idempotencyKey: key } });
  }
});
