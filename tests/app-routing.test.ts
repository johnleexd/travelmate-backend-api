import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import app from "../src/app.ts";

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
});

test("system and API fallback routes remain wired", async () => {
  const information = await fetch(`${baseUrl}/`);
  assert.equal(information.status, 200);
  assert.deepEqual(await information.json(), { name: "TravelMate API", status: "ok" });

  const missing = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "API route not found." });
});

test("every protected feature route resolves to its controller", async () => {
  const routes: Array<[string, RequestInit?]> = [
    ["/api/platform"],
    ["/api/itinerary", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ["/api/weather"],
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
  const session = await fetch(`${baseUrl}/api/auth`);
  assert.equal(session.status, 401);
  assert.deepEqual(await session.json(), { error: "Unauthenticated." });

  const invalidJson = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "Request body must be valid JSON." });
});
