import assert from "node:assert/strict";
import test from "node:test";
import { isStrongPassword } from "../src/schemas/auth/password-schema.ts";

test("registration password schema accepts every required character class", () => {
  assert.equal(isStrongPassword("Travel123!"), true);
  assert.equal(isStrongPassword("CebuTrip#2026"), true);
});

test("registration password schema rejects weak or whitespace passwords", () => {
  for (const password of [
    "short1!",
    "travel123!",
    "TRAVEL123!",
    "TravelMate!",
    "Travel1234",
    "Travel 123!",
    `Travel123!${"a".repeat(55)}`,
  ]) {
    assert.equal(isStrongPassword(password), false, `${password} should be rejected`);
  }
});
