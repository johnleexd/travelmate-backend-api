import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createSessionToken, verifySessionToken } from '../src/middlewares/auth-middleware.ts';

test('only traveler and admin sessions remain valid', () => {
  for (const role of ['traveler', 'admin'] as const) {
    assert.equal(verifySessionToken(createSessionToken('role-test', role))?.role, role);
  }
  const payload = Buffer.from(JSON.stringify({ userId: 'legacy-owner', role: 'owner', exp: Date.now() + 60_000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET || 'travelmate-local-development-secret-change-me').update(payload).digest('base64url');
  assert.equal(verifySessionToken(`${payload}.${signature}`), null);
});
