import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import app from "../src/app.ts";
import { prisma } from "../src/lib/prisma.ts";

let baseUrl = "";
const server = app.listen(0);

before(async () => {
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await prisma.$disconnect();
});

test("system and API fallback routes remain wired", async () => {
  const information = await fetch(`${baseUrl}/`);
  assert.equal(information.status, 200);
  assert.deepEqual(await information.json(), { name: "TravelMate API", status: "ok" });

  const missing = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "API route not found.", code: "NOT_FOUND", retryable: false });
});

function mockHealthQuery(t: import('node:test').TestContext, implementation: (...args: never[]) => Promise<unknown>) {
  const previous = Reflect.get(prisma, '$queryRaw');
  const query = t.mock.fn(implementation);
  Reflect.set(prisma, '$queryRaw', query);
  t.after(() => Reflect.set(prisma, '$queryRaw', previous));
  return query;
}

test('readiness verifies the database and cannot be cached', async t => {
  const query = mockHealthQuery(t, async (sql: TemplateStringsArray) => {
    assert.equal(sql.join(''), 'SELECT 1');
    return [{ result: 1 }];
  });
  const response = await fetch(`${baseUrl}/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
  assert.equal(query.mock.calls.length, 1);
});

test('readiness returns 503 without exposing database errors', async t => {
  mockHealthQuery(t, async () => { throw new Error('Private database connection details'); });
  t.mock.method(console, 'error', () => {});
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'error', database: 'unavailable' });
});

test('liveness remains available without accessing a failed database', async t => {
  const query = mockHealthQuery(t, async () => { throw new Error('Database is down'); });
  const response = await fetch(`${baseUrl}/health/live`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(query.mock.calls.length, 0);
});

test("every protected feature route resolves to its controller", async () => {
  const routes: Array<[string, RequestInit?]> = [
    ["/api/platform"],
    ["/api/itinerary", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/itinerary/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/weather"],
    ["/api/destination-context/exchange-rate"],
    ["/api/locations"],
    ["/api/accommodations"],
    ["/api/travel-options"],
    ["/api/profile"],
    ["/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }],
  ];

  for (const [path, options] of routes) {
    const response = await fetch(`${baseUrl}${path}`, options);
    assert.equal(response.status, 401, `${path} should be handled and require authentication`);
  }
});

test("authentication routes and JSON error middleware remain wired", async () => {
  const googleStatus = await fetch(`${baseUrl}/api/auth/oauth/google/status`);
  assert.equal(googleStatus.status, 200);
  const provider = await googleStatus.json() as { available?: unknown };
  assert.equal(typeof provider.available, 'boolean');

  const session = await fetch(`${baseUrl}/api/auth`);
  assert.equal(session.status, 401);
  assert.deepEqual(await session.json(), { error: "Unauthenticated.", code: "AUTHENTICATION_REQUIRED", retryable: false });

  const invalidJson = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "Request body must be valid JSON.", code: "BAD_REQUEST", retryable: false });
});

test("registration rejects weak passwords before account persistence", async (t) => {
  // Throttling uses storage even when account input is rejected.
  const methods = [
    [prisma, '$queryRaw', async () => [{ count: 1, reset_at: new Date() }]],
    [prisma, '$executeRaw', async () => 0],
    [prisma.revokedSession, 'deleteMany', async () => ({ count: 0 })],
  ] as const;
  for (const [target, key, implementation] of methods) {
    const previous = Reflect.get(target, key);
    Reflect.set(target, key, t.mock.fn(implementation));
    t.after(() => Reflect.set(target, key, previous));
  }
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "register",
      name: "Password Test",
      email: "password-test@example.com",
      password: "weakpass1!",
      role: "traveler",
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Password must include an uppercase letter.",
    code: "BAD_REQUEST",
    retryable: false,
  });
});
