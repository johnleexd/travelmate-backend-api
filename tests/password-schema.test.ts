import assert from "node:assert/strict";
import test from "node:test";
import { isStrongPassword, getPasswordValidationError } from "../src/schemas/auth/password-schema.ts";

test('backend password errors identify the failing rule without trimming', () => {
  assert.equal(getPasswordValidationError('Travel123!'), null);
  assert.equal(getPasswordValidationError('Travel123! '), 'Password must not contain spaces or other whitespace.');
  assert.equal(getPasswordValidationError('travel123!'), 'Password must include an uppercase letter.');
  assert.equal(getPasswordValidationError('TravelMate!'), 'Password must include a number.');
});

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
