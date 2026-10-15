import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedOrigins,
  requestOriginAllowed,
  requestUsesHttps,
} from "../src/middlewares/security-middleware.ts";

test("allowed origins support a comma-separated deployment allowlist", () => {
  assert.deepEqual(
    allowedOrigins({ FRONTEND_URL: "https://travelmate.example, https://admin.travelmate.example/" }),
    ["https://travelmate.example", "https://admin.travelmate.example", "https://www.travel-mate.site", "https://travel-mate.site"],
  );
});

test("TravelMate frontend origins remain trusted alongside local or configured origins", () => {
  const deployedOrigins = ["https://www.travel-mate.site", "https://travel-mate.site"];
  assert.deepEqual(allowedOrigins({}), ["http://localhost:3000", ...deployedOrigins]);
  assert.deepEqual(allowedOrigins({ FRONTEND_URL: "https://www.travel-mate.site/, https://travel-mate.site, https://www.travel-mate.site" }), deployedOrigins);
  for (const origin of deployedOrigins) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(requestOriginAllowed(method, origin, "same-site", allowedOrigins({ FRONTEND_URL: "https://other.example" })), true);
    }
  }
});

test("same-origin write protection accepts trusted and non-browser requests", () => {
  const origins = ["https://travelmate.example"];
  assert.equal(requestOriginAllowed("POST", "https://travelmate.example", "same-origin", origins), true);
  assert.equal(requestOriginAllowed("POST", undefined, undefined, origins), true);
  assert.equal(requestOriginAllowed("GET", "https://attacker.example", "cross-site", origins), true);
});

test("same-origin write protection rejects cross-site mutations", () => {
  const origins = ["https://travelmate.example"];
  assert.equal(requestOriginAllowed("POST", "https://attacker.example", "cross-site", origins), false);
  assert.equal(requestOriginAllowed("PATCH", undefined, "cross-site", origins), false);
  assert.equal(requestOriginAllowed("DELETE", "https://attacker.example", undefined, origins), false);
});

test("HTTPS detection honors direct TLS and the trusted proxy protocol", () => {
  assert.equal(requestUsesHttps({ secure: true, get: () => undefined }), true);
  assert.equal(requestUsesHttps({ secure: false, get: () => "https" }), true);
  assert.equal(requestUsesHttps({ secure: false, get: () => "https, http" }), true);
  assert.equal(requestUsesHttps({ secure: false, get: () => "http" }), false);
  assert.equal(requestUsesHttps({ secure: false, get: () => undefined }), false);
});
