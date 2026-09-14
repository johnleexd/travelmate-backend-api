import assert from "node:assert/strict";
import test from "node:test";
import { ProfileValidationError } from "../src/exceptions/index.ts";
import { validateProfileUpdate } from "../src/services/profile/profile-service.ts";

test("profile updates normalize supported fields", () => {
  assert.deepEqual(
    validateProfileUpdate({ name: "  Ada Traveler  ", phone: " +63 917 123 4567 ", bio: "  Loves nature trips.  " }),
    { name: "Ada Traveler", phone: "+63 917 123 4567", bio: "Loves nature trips." },
  );
});

test("profile updates allow optional fields to be cleared", () => {
  assert.deepEqual(validateProfileUpdate({ phone: "", bio: null }), { phone: null, bio: null });
});

test("profile updates reject invalid names and phone characters", () => {
  assert.throws(() => validateProfileUpdate({ name: "x" }), ProfileValidationError);
  assert.throws(() => validateProfileUpdate({ phone: "call me!" }), ProfileValidationError);
});

test("profile updates require at least one supported field", () => {
  assert.throws(() => validateProfileUpdate({ email: "new@example.com" }), ProfileValidationError);
});
