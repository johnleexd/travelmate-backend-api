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


test('photos require HTTPS and privileged profile fields cannot be changed', () => {
  assert.deepEqual(validateProfileUpdate({ avatarUrl: ' https://example.test/photo.jpg ' }), { avatarUrl: 'https://example.test/photo.jpg' });
  assert.deepEqual(validateProfileUpdate({ avatarUrl: '' }), { avatarUrl: null });
  for (const avatarUrl of ['javascript:alert(1)', 'data:image/png;base64,AA', 'http://example.test/photo.jpg', 'https://user:secret@example.test/photo.jpg', 'invalid']) {
    assert.throws(() => validateProfileUpdate({ avatarUrl }), ProfileValidationError);
  }
  assert.deepEqual(validateProfileUpdate({ name: 'Admin Name', id: 'another-user', role: 'admin', accountStatus: 'active', createdAt: '2020-01-01' }), { name: 'Admin Name' });
});
