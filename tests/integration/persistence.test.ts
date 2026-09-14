import assert from "node:assert/strict";
import test from "node:test";
import { publicUser } from "../../src/schemas/domain.ts";
import { prisma } from "../../src/lib/prisma.ts";
import { authenticateUser } from "../../src/services/auth/auth-service.ts";
import { executePlatformAction } from "../../src/services/platform/platform-service.ts";
import * as authRoute from "../../src/controllers/auth-controller.ts";

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
      budget: 10000,
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      travelers: 1,
      interests: ["testing"],
      itinerary: { destination: "Integration Test Destination", days: [{ day: 1, date: "2026-10-01", activities: [{ title: "Integration activity", estimatedCost: 100 }] }] },
      weather: null,
    }) as { id: string };
    tripId = result.id;

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
      startDate: "2026-10-10",
      endDate: "2026-10-11",
      travelers: 1,
      interests: ["security"],
      itinerary: { destination: "Ownership Test Destination", days: [{ day: 1, activities: [{ title: "Day one", estimatedCost: 100 }] }, { day: 2, activities: [{ title: "Day two", estimatedCost: 100 }] }] },
      weather: null,
    }) as { id: string };
    ids.push(created.id);

    await assert.rejects(
      executePlatformAction(publicUser(other), "delete-trip", { id: created.id }),
      /Saved trip not found/,
    );

    const updated = await executePlatformAction(publicUser(owner), "update-trip", {
      id: created.id,
      destination: "Updated Ownership Destination",
      budget: 13000,
      startDate: "2026-10-10",
      endDate: "2026-10-11",
      travelers: 1,
      interests: ["security", "crud"],
      itinerary: { destination: "Updated Ownership Destination", days: [{ day: 1, activities: [{ title: "Day one", estimatedCost: 100 }] }, { day: 2, activities: [{ title: "Day two", estimatedCost: 100 }] }] },
      weather: null,
    }) as { destination: string };
    assert.equal(updated.destination, "Updated Ownership Destination");

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

    const duplicate = await executePlatformAction(publicUser(owner), "duplicate-trip", { id: created.id }) as { id: string };
    ids.push(duplicate.id);
    assert.notEqual(duplicate.id, created.id);

    await executePlatformAction(publicUser(owner), "delete-trip", { id: duplicate.id });
    assert.equal(await prisma.trip.findUnique({ where: { id: duplicate.id } }), null);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ targetId: { in: ids } }, { actorId: other.id }] } });
    await prisma.trip.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.delete({ where: { id: other.id } });
  }
});
