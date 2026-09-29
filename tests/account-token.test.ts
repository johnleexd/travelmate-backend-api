import assert from 'node:assert/strict';
import test from 'node:test';
import { generateAccountCode, hashAccountToken } from '../src/services/auth/auth-service.ts';

test('account codes are random eight-character hexadecimal values', () => {
  const first = generateAccountCode();
  const second = generateAccountCode();
  assert.match(first, /^[A-F0-9]{8}$/);
  assert.match(second, /^[A-F0-9]{8}$/);
  assert.notEqual(first, second);
});

test('account token hashes are deterministic and case insensitive', () => {
  const secret = 'test-account-token-secret';
  const hash = hashAccountToken('a1b2c3d4', secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, hashAccountToken(' A1B2C3D4 ', secret));
  assert.notEqual(hash, hashAccountToken('A1B2C3D5', secret));
});
