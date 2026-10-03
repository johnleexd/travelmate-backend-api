import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import app from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { password } from '../src/repositories/platform-repository.ts';

const user = {
  id: 'connection-recovery-test', name: 'Recovery Test', email: 'recovery@example.test', role: 'traveler',
  emailVerified: true, profileStatus: 'unverified', trustScore: 50, accountStatus: 'active',
  sessionVersion: 2, passwordSalt: 'test-salt', passwordHash: password('Travel123!', 'test-salt'),
};
const sessionHeaders = () => ({ cookie: `travelmate_session=${createSessionToken(user.id, 'traveler', user.sessionVersion)}` });
const server = app.listen(0);
let baseUrl = '';

// Prisma exposes methods through proxies rather than property descriptors.
function mockPrismaMethod(t: TestContext, target: object, key: string, implementation: (...args: never[]) => unknown) {
  const previous = Reflect.get(target, key);
  const mocked = t.mock.fn(implementation);
  Reflect.set(target, key, mocked);
  t.after(() => { Reflect.set(target, key, previous); });
  return mocked;
}

before(async () => {
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});

test('session check recovers from P1017 without invalidating the session', async t => {
  let attempts = 0;
  const lookup = mockPrismaMethod(t, prisma.user, 'findFirst', async (query: { where: unknown }) => {
    assert.deepEqual(query.where, { id: user.id, role: 'traveler', sessionVersion: 2 });
    if (++attempts === 1) throw { code: 'P1017' };
    return user;
  });
  const response = await fetch(`${baseUrl}/api/auth`, { headers: sessionHeaders() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, user.id);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(lookup.mock.callCount(), 2);
});

test('persistent database loss returns retryable 503 rather than a logout or generic 500', async t => {
  t.mock.method(console, 'warn', () => {});
  const lookup = mockPrismaMethod(t, prisma.user, 'findFirst', async () => { throw { code: 'P1017' }; });
  const response = await fetch(`${baseUrl}/api/auth`, { headers: sessionHeaders() });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), {
    error: 'TravelMate is temporarily unavailable. Please try again shortly.', code: 'PROVIDER_UNAVAILABLE', retryable: true,
  });
  assert.equal(lookup.mock.callCount(), 3);
});

test('invalid and revoked sessions remain unauthorized', async t => {
  const lookup = mockPrismaMethod(t, prisma.user, 'findFirst', async () => null);
  const invalid = await fetch(`${baseUrl}/api/auth`, { headers: { cookie: 'travelmate_session=invalid' } });
  assert.equal(invalid.status, 401);
  assert.equal(lookup.mock.callCount(), 0);
  const revoked = await fetch(`${baseUrl}/api/auth`, { headers: sessionHeaders() });
  assert.equal(revoked.status, 401);
  assert.equal(lookup.mock.callCount(), 1);
});

test('logout clears the app session and pending OAuth flow even while the database is unavailable', async t => {
  const limiter = mockPrismaMethod(t, prisma, '$queryRaw', async () => { throw { code: 'P1017' }; });
  const lookup = mockPrismaMethod(t, prisma.user, 'findFirst', async () => { throw new Error('Logout must not require a user lookup.'); });
  const audit = mockPrismaMethod(t, prisma.auditEvent, 'create', async () => ({}));
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST', headers: { ...sessionHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some(cookie => cookie.startsWith('travelmate_session=;') && cookie.includes('Max-Age=0')));
  assert.ok(cookies.some(cookie => cookie.startsWith('travelmate_google_oauth=;') && cookie.includes('Max-Age=0')));
  assert.equal(limiter.mock.callCount(), 3);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(audit.mock.callCount(), 0);
  const session = await fetch(`${baseUrl}/api/auth`);
  assert.equal(session.status, 401);
});

test('password login recovers both its rate limiter and credential read', async t => {
  let limiterAttempts = 0;
  let lookupAttempts = 0;
  mockPrismaMethod(t, prisma, '$queryRaw', async () => {
    if (++limiterAttempts === 1) throw { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'ConnectionClosed' } } } };
    return [{ count: 1, reset_at: new Date() }];
  });
  mockPrismaMethod(t, prisma, '$executeRaw', async () => 0);
  mockPrismaMethod(t, prisma.user, 'findUnique', async () => {
    if (++lookupAttempts === 1) throw { code: 'P1017' };
    return user;
  });
  mockPrismaMethod(t, prisma.auditEvent, 'create', async () => ({}));
  const response = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: user.email, password: 'Travel123!' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).redirect, '/dashboard');
  assert.match(response.headers.get('set-cookie') || '', /travelmate_session=.+; Path=\/; HttpOnly/);
  assert.equal(limiterAttempts, 3);
  assert.equal(lookupAttempts, 2);
});

test('Google sign-in can start after a nested driver connection failure', async t => {
  const configuration = {
    GOOGLE_CLIENT_ID: '123456789-travelmate.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/api/auth/oauth/google/callback',
    OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
  };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  Object.assign(process.env, configuration);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let attempts = 0;
  mockPrismaMethod(t, prisma, '$queryRaw', async () => {
    if (++attempts === 1) throw { meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } } } };
    return [{ count: 1, reset_at: new Date() }];
  });
  mockPrismaMethod(t, prisma, '$executeRaw', async () => 0);
  const response = await fetch(`${baseUrl}/api/auth/oauth/google`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get('location')!);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('prompt'), 'select_account');
  assert.match(response.headers.get('set-cookie') || '', /HttpOnly; SameSite=Lax/);
  assert.equal(attempts, 2);

  mockPrismaMethod(t, prisma.auditEvent, 'create', async () => ({}));
  const logout = await fetch(`${baseUrl}/api/auth`, {
    method: 'POST', headers: { ...sessionHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  });
  assert.equal(logout.status, 200);
  const next = await fetch(`${baseUrl}/api/auth/oauth/google`, { redirect: 'manual' });
  assert.equal(next.status, 302);
  const nextAuthorization = new URL(next.headers.get('location')!);
  assert.equal(nextAuthorization.searchParams.get('prompt'), 'select_account');
  assert.equal(nextAuthorization.searchParams.has('login_hint'), false);
  assert.notEqual(nextAuthorization.searchParams.get('state'), authorization.searchParams.get('state'));
  assert.notEqual(nextAuthorization.searchParams.get('nonce'), authorization.searchParams.get('nonce'));
  assert.ok(next.headers.getSetCookie().every(cookie => !cookie.startsWith('travelmate_session=')));
});
