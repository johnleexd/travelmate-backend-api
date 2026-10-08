import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import app from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken, verifySessionToken } from '../src/middlewares/auth-middleware.ts';
import { resetPassword } from '../src/services/auth/auth-service.ts';
import { findOrCreateGoogleUser, safeStateMatches, unsealOAuthFlow } from '../src/services/auth/google-oauth-service.ts';
import { beginGeneration } from '../src/controllers/itinerary-controller.ts';
import { demoSeedPasswords } from '../src/services/auth/demo-seed-policy.ts';
import { createOfferToken, verifyOfferToken } from '../src/utils/offer-token.ts';
import { createTravelSelectionToken, verifyTravelSelectionToken } from '../src/utils/travel-selection-token.ts';

const user = {
  id: 'audit-regression-user', name: 'Security Test', email: 'security@example.test', role: 'traveler',
  emailVerified: true, profileStatus: 'unverified', accountStatus: 'active', trustScore: 50,
  sessionVersion: 0, passwordHash: null, passwordSalt: null,
};
const server = app.listen(0, '127.0.0.1');
let baseUrl = '';

function mockMethod(t: TestContext, target: object, key: string, implementation: (...args: any[]) => any) {
  const previous = Reflect.get(target, key);
  Reflect.set(target, key, t.mock.fn(implementation));
  t.after(() => { Reflect.set(target, key, previous); });
}
before(async () => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});

test('malformed and noncanonical session cookies are rejected without server errors', async () => {
  const valid = createSessionToken(user.id, 'traveler');
  const bad = [`invalid-payload.${'é'.repeat(43)}`, `${valid}.extra`, `${valid}.`, 'not-a-token'];
  for (const token of bad) {
    assert.equal(verifySessionToken(token), null);
    const response = await fetch(`${baseUrl}/api/auth`, { headers: { cookie: `travelmate_session=${token}` } });
    assert.equal(response.status, 401);
  }
});

test('all signed token helpers safely reject equal-character-length multibyte input', () => {
  const offer = { hotelId: 'hotel', offerId: 'offer', name: 'Hotel', nightlyRate: 100, currency: 'PHP', isLive: false };
  const selection = { kind: 'flight' as const, id: 'flight', name: 'Flight', price: 100, currency: 'PHP', fetchedAt: new Date().toISOString() };
  const bad = 'é'.repeat(43);
  assert.equal(verifyOfferToken(offer, createOfferToken(offer)), true);
  assert.equal(verifyTravelSelectionToken(selection, createTravelSelectionToken(selection)), true);
  assert.equal(verifyOfferToken(offer, bad), false);
  assert.equal(verifyTravelSelectionToken(selection, bad), false);
  assert.equal(safeStateMatches('a'.repeat(43), bad), false);
  assert.equal(unsealOAuthFlow(`payload.${bad}`, 'test-state-secret'), null);
});

test('logout rejects a copied token while another login for the same account stays valid', async t => {
  const revoked = new Set<string>();
  mockMethod(t, prisma.revokedSession, 'upsert', async query => { revoked.add(query.create.tokenHash); return query.create; });
  mockMethod(t, prisma.revokedSession, 'deleteMany', async () => ({ count: 0 }));
  mockMethod(t, prisma.user, 'findFirst', async query => revoked.has(query.where.revokedSessions.none.tokenHash) ? null : user);
  mockMethod(t, prisma, '$queryRaw', async () => [{ count: 1, reset_at: new Date() }]);
  mockMethod(t, prisma, '$executeRaw', async () => 0);
  mockMethod(t, prisma.auditEvent, 'create', async () => ({}));
  const cookie = `travelmate_session=${createSessionToken(user.id, 'traveler')}`;
  const other = `travelmate_session=${createSessionToken(user.id, 'traveler')}`;
  assert.notEqual(cookie, other);
  const logout = await fetch(`${baseUrl}/api/auth`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"action":"logout"}' });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true, sessionRevoked: true });
  assert.equal((await fetch(`${baseUrl}/api/auth`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth`, { headers: { cookie: other } })).status, 200);
});

test('one reset token has exactly one successful consumer during overlapping resets', async t => {
  let reads = 0;
  let writes = 0;
  let available = true;
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  const transaction = {
    accountToken: {
      findFirst: async () => { if (++reads === 2) release(); await bothRead; return { id: 'token', userId: user.id, user }; },
      deleteMany: async query => {
        if (!query.where.id) return { count: 0 };
        const count = available ? 1 : 0;
        available = false;
        return { count };
      },
    },
    user: { update: async () => { writes++; return user; } },
  };
  mockMethod(t, prisma, '$transaction', async callback => callback(transaction));
  const results = await Promise.all([
    resetPassword(user.email, 'TESTCODE', 'DifferentPassword1!'),
    resetPassword(user.email, 'TESTCODE', 'DifferentPassword2!'),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(writes, 1);
});

test('overlapping retries acquire a failed generation only once', async t => {
  const body = { destination: 'Cebu', budget: 1000 };
  let current = { id: 'generation', attemptId: 'old-attempt', status: 'failed', response: null,
    requestHash: createHash('sha256').update('{"budget":1000,"destination":"Cebu"}').digest('hex'), updatedAt: new Date() };
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  mockMethod(t, prisma.itineraryGeneration, 'findUnique', async () => {
    const snapshot = { ...current };
    if (++reads === 2) release();
    await bothRead;
    return snapshot;
  });
  mockMethod(t, prisma.itineraryGeneration, 'updateMany', async query => {
    if (query.where.attemptId !== current.attemptId || query.where.status !== current.status) return { count: 0 };
    current = { ...current, ...query.data };
    return { count: 1 };
  });
  const results = await Promise.all([beginGeneration(user.id, 'Cebu', body, 'same-retry-key'), beginGeneration(user.id, 'Cebu', body, 'same-retry-key')]);
  assert.equal(results.filter(result => 'recordId' in result).length, 1);
  assert.equal(results.filter(result => 'conflict' in result).length, 1);
});

test('Google recovery verifies email, discards unverified credentials and invalidates old sessions/codes', async t => {
  let existing = { ...user, email: 'security-regression@gmail.com', emailVerified: false, passwordHash: 'unverified-password', passwordSalt: 'unverified-salt' };
  let removedCodes = false;
  const transaction = {
    oAuthAccount: { findUnique: async () => null, create: async () => ({}) },
    accountToken: { deleteMany: async () => { removedCodes = true; return { count: 1 }; } },
    user: {
      findUnique: async () => existing,
      updateMany: async query => { existing = { ...existing, ...query.data, sessionVersion: existing.sessionVersion + 1 }; return { count: 1 }; },
      findUniqueOrThrow: async () => existing,
    },
  };
  mockMethod(t, prisma, '$transaction', async callback => callback(transaction));
  const result = await findOrCreateGoogleUser({ subject: 'google-subject', email: existing.email, name: existing.name, authoritativeEmail: true });
  assert.equal(result.user.emailVerified, true);
  assert.equal(existing.passwordHash, null);
  assert.equal(existing.passwordSalt, null);
  assert.equal(result.sessionVersion, 1);
  assert.equal(removedCodes, true);
});

test('every audited protected endpoint distinguishes database outages from invalid sessions', async t => {
  t.mock.method(console, 'warn', () => {});
  mockMethod(t, prisma.user, 'findFirst', async () => { throw { code: 'P1017' }; });
  const headers = { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` };
  for (const path of ['/api/auth', '/api/profile', '/api/platform', '/api/platform/notifications', '/api/platform/trips/owned-trip', '/api/platform/trips/owned-trip/versions', '/api/locations?q=Cebu', '/api/locations/current', '/api/accommodations', '/api/travel-options', '/api/weather', '/api/destination-context', '/api/destination-context/exchange-rate']) {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('retry-after'), '1', path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    assert.equal((await response.json()).retryable, true, path);
  }
});

test('demo account creation requires explicit local opt-in and distinct private passwords', () => {
  const environment = { TRAVELMATE_ALLOW_DEMO_SEED: 'true', DEMO_ADMIN_PASSWORD: 'PrivateAdminPassword1!', DEMO_TRAVELER_PASSWORD: 'PrivateTravelerPassword2!' };
  assert.throws(() => demoSeedPasswords({ ...environment, NODE_ENV: 'production' }), /disabled/);
  assert.throws(() => demoSeedPasswords({ ...environment, TRAVELMATE_ALLOW_DEMO_SEED: '' }), /disabled/);
  assert.throws(() => demoSeedPasswords({ ...environment, DEMO_ADMIN_PASSWORD: 'Travel123!' }), /distinct/);
  assert.deepEqual(demoSeedPasswords(environment), { admin: environment.DEMO_ADMIN_PASSWORD, traveler: environment.DEMO_TRAVELER_PASSWORD });
});
