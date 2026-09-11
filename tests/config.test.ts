import assert from "node:assert/strict";
import test from "node:test";
import { validateRuntimeEnvironment } from "../src/config.ts";

test("development runtime accepts local defaults", () => {
  assert.doesNotThrow(() => validateRuntimeEnvironment({ NODE_ENV: "development" }));
});

test("production runtime requires a strong session secret", () => {
  assert.throws(
    () => validateRuntimeEnvironment({ NODE_ENV: "production", FRONTEND_URL: "https://travelmate.example", SESSION_SECRET: "short" }),
    /SESSION_SECRET/,
  );
});

test("production runtime requires canonical HTTPS frontend origins", () => {
  const base = { NODE_ENV: "production", SESSION_SECRET: "a-secure-session-secret-with-32-characters" };
  assert.throws(() => validateRuntimeEnvironment({ ...base }), /FRONTEND_URL/);
  assert.throws(() => validateRuntimeEnvironment({ ...base, FRONTEND_URL: "http://travelmate.example" }), /HTTPS/);
  assert.doesNotThrow(() => validateRuntimeEnvironment({ ...base, FRONTEND_URL: "https://travelmate.example,https://admin.travelmate.example/" }));
});
