import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { password } from '../../src/repositories/platform-repository.ts';
import { createSessionToken, currentUser, revokeRequestSession } from '../../src/middlewares/auth-middleware.ts';
import { hashAccountToken, resetPassword } from '../../src/services/auth/auth-service.ts';
import { findOrCreateGoogleUser } from '../../src/services/auth/google-oauth-service.ts';
import { beginGeneration, completeGeneration } from '../../src/controllers/itinerary-controller.ts';

after(() => prisma.$disconnect());

async function fixtureUser(verified = true) {
  const id = randomUUID();
  return prisma.user.create({ data: {
    id, email: `audit.${id}@${verified ? 'example.test' : 'gmail.com'}`, name: 'Isolated Security Fixture',
    role: 'traveler', emailVerified: verified, passwordSalt: 'fixture-salt', passwordHash: password('FixturePassword1!', 'fixture-salt'),
  } });
}

test('real database allows only one consumer of a reset code', async () => {
  const user = await fixtureUser();
  try {
    await prisma.accountToken.create({ data: { userId: user.id, kind: 'password_reset', tokenHash: hashAccountToken('A1B2C3D4'), expiresAt: new Date(Date.now() + 60000) } });
    const results = await Promise.all([resetPassword(user.email, 'A1B2C3D4', 'ReplacementPassword1!'), resetPassword(user.email, 'A1B2C3D4', 'ReplacementPassword2!')]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion, 1);
    assert.equal(await prisma.accountToken.count({ where: { userId: user.id } }), 0);
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('real session revocation blocks replay while a different login remains valid', async () => {
  const user = await fixtureUser();
  try {
    const request = new Request('http://localhost/api/auth', { headers: { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` } });
    const other = new Request('http://localhost/api/auth', { headers: { cookie: `travelmate_session=${createSessionToken(user.id, 'traveler')}` } });
    assert.equal((await currentUser(request))?.id, user.id);
    await revokeRequestSession(request);
    assert.equal(await currentUser(request), null);
    assert.equal((await currentUser(other))?.id, user.id);
    await revokeRequestSession(request);
    assert.equal(await prisma.revokedSession.count({ where: { userId: user.id } }), 1);
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('real generation claims prevent duplicate retries and late attempt completion', async () => {
  const user = await fixtureUser();
  try {
    const body = { destination: 'Tokyo', budget: 1000 };
    const started = await beginGeneration(user.id, 'Tokyo', body, 'fixture-generation-key');
    assert.ok('recordId' in started && started.recordId && started.attemptId);
    const { releaseGeneration } = await import('../../src/services/plans/plan-service.ts');
    await releaseGeneration(started.recordId, started.attemptId, 'CONFIRMED_FAILURE');
    const results = await Promise.allSettled([beginGeneration(user.id, 'Tokyo', body, 'fixture-generation-key'), beginGeneration(user.id, 'Tokyo', body, 'fixture-generation-key')]);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'GENERATION_ENDED'));
    const winner = await beginGeneration(user.id, 'Tokyo', body, 'explicit-new-generation-key');
    assert.ok('recordId' in winner && winner.recordId && winner.attemptId);
    assert.equal(await completeGeneration(started.recordId, started.attemptId, { obsolete: true }), false);
    assert.equal(await completeGeneration(winner.recordId, winner.attemptId, { destination: 'Tokyo', verified: true }), true);
    const replay = await beginGeneration(user.id, 'Tokyo', body, 'explicit-new-generation-key');
    assert.ok('replay' in replay);
    assert.deepEqual(replay.replay, { destination: 'Tokyo', verified: true });
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('real Google linking cannot enable the password set on an unverified account', async () => {
  const user = await fixtureUser(false);
  try {
    await prisma.accountToken.create({ data: { userId: user.id, kind: 'email_verification', tokenHash: hashAccountToken(randomUUID()), expiresAt: new Date(Date.now() + 60000) } });
    const result = await findOrCreateGoogleUser({ subject: `fixture-${randomUUID()}`, email: user.email, name: user.name, authoritativeEmail: true });
    assert.equal(result.user.emailVerified, true);
    assert.equal(result.sessionVersion, 1);
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(saved.passwordHash, null);
    assert.equal(saved.passwordSalt, null);
    assert.equal(await prisma.accountToken.count({ where: { userId: user.id } }), 0);
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});
