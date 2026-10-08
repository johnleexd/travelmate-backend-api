import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import nodemailer from 'nodemailer';
import { prisma } from '../../src/lib/prisma.ts';
import { POST } from '../../src/controllers/auth-controller.ts';
import { generateAccountCode, hashAccountToken, hashVerificationCode, reissueVerificationCode, verifyEmail, VerificationCooldownError } from '../../src/services/auth/auth-service.ts';

after(() => prisma.$disconnect());

async function cleanup(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) await prisma.auditEvent.deleteMany({ where: { actorId: user.id } });
  await prisma.user.deleteMany({ where: { email } });
}

for (const provider of ['resend', 'gmail']) {
test(`${provider}: verification is email-only, expires, limits guesses and consumes one code once`, async t => {
  const email = `verification-${randomUUID()}@example.test`;
  const original = { ...process.env };
  process.env.EMAIL_PROVIDER = provider;
  process.env.NODE_ENV = 'development';
  process.env.SMTP_USER = 'sender@gmail.com';
  process.env.SMTP_PASS = 'abcdefghijklmnop';
  process.env.RESEND_API_KEY = 're_test_transport';
  process.env.EMAIL_FROM = provider === 'gmail' ? 'TravelMate <sender@gmail.com>' : 'TravelMate <noreply@example.test>';
  const deliveries: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(payload.to, [email]);
    assert.match(payload.text, /5 minutes/);
    deliveries.push(payload.text.match(/code is ([A-F0-9]{8})/)[1]);
    return Response.json({ id: 'test-delivery' });
  });
  t.mock.method(nodemailer, 'createTransport', () => ({ close() {}, async sendMail(payload) {
    assert.equal(payload.to, email);
    assert.match(payload.text, /5 minutes/);
    deliveries.push(payload.text.match(/code is ([A-F0-9]{8})/)[1]);
    return { accepted: [email], rejected: [], messageId: '<test@gmail.com>' };
  } }));
  t.after(async () => {
    await cleanup(email);
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'SMTP_USER', 'SMTP_PASS', 'NODE_ENV']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });
  const request = (action: string, extra = {}) => POST(new Request('http://localhost/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client-ip': email },
    body: JSON.stringify({ action, email, ...extra }),
  }));
  const mismatch = await request('register', { name: 'Verification Test', password: 'StrongPass123!', confirmPassword: 'StrongPass123! ' });
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error, /Confirm password does not match Password/);
  assert.equal(await prisma.user.findUnique({ where: { email } }), null);
  const registration = await request('register', { name: 'Verification Test', password: 'StrongPass123!', confirmPassword: 'StrongPass123!' });
  assert.equal(registration.status, 201);
  const payload = await registration.json();
  assert.equal(payload.emailAccepted, true);
  assert.equal('verificationCode' in payload, false);
  assert.equal(JSON.stringify(payload).includes(deliveries[0]), false);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  assert.match(user.passwordHash!, /^[a-f0-9]{128}$/);
  assert.match(user.passwordSalt!, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(payload).includes('StrongPass123!'), false);
  assert.equal(user.emailVerified, false);
  const token = await prisma.accountToken.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: 'email_verification' } } });
  assert.equal(JSON.stringify(token).includes('StrongPass123!'), false);
  assert.equal(token.tokenHash, hashVerificationCode(user.id, deliveries[0]));
  assert.ok(token.expiresAt.getTime() - token.createdAt.getTime() <= 300_000);
  assert.equal((await request('login', { password: 'StrongPass123!' })).status, 403);
  assert.equal((await request('resend-verification')).status, 429);
  assert.equal(deliveries.length, 1);
  assert.equal(await verifyEmail('another@example.test', deliveries[0]), null);
  assert.notEqual(hashVerificationCode('another-user', deliveries[0]), token.tokenHash);
  const resetCode = generateAccountCode();
  await prisma.accountToken.create({ data: { userId: user.id, kind: 'password_reset', tokenHash: hashAccountToken(resetCode), expiresAt: new Date(Date.now() + 300_000) } });
  assert.equal(await verifyEmail(email, resetCode), null, 'a password reset code cannot verify an email');

  for (let attempt = 0; attempt < 5; attempt++) assert.equal(await verifyEmail(email, 'NOTACODE'), null);
  assert.equal(await verifyEmail(email, deliveries[0]), null, 'exhausted code cannot verify');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerified, false);

  await prisma.accountToken.update({ where: { id: token.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
  const resend = await request('resend-verification');
  assert.equal(resend.status, 200);
  const resent = await resend.json();
  assert.equal('verificationCode' in resent, false);
  assert.equal(resent.emailAccepted, true);
  assert.equal(deliveries.length, 2);
  assert.equal(await verifyEmail(email, deliveries[0]), null, 'previous code is invalidated');

  await prisma.accountToken.update({ where: { id: token.id }, data: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal(await verifyEmail(email, deliveries[1]), null, 'expired code cannot verify');
  await prisma.accountToken.update({ where: { id: token.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
  const candidates = [generateAccountCode(), generateAccountCode()];
  const resends = await Promise.allSettled(candidates.map(code => reissueVerificationCode(email, code)));
  assert.equal(resends.filter(result => result.status === 'fulfilled').length, 1, 'concurrent resends enforce cooldown');
  const finalCode = candidates[resends.findIndex(result => result.status === 'fulfilled')];
  const consumers = await Promise.all([verifyEmail(email, finalCode), verifyEmail(email, finalCode)]);
  assert.equal(consumers.filter(Boolean).length, 1, 'concurrent verification has one successful consumer');
  assert.equal(await verifyEmail(email, finalCode), null, 'code cannot be replayed');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerified, true);
  assert.equal((await request('login', { password: 'StrongPass123!' })).status, 200);
  const beforeResend = deliveries.length;
  // An already verified account must never receive a misleading send receipt.
  const ineligible = await request('resend-verification');
  assert.equal(ineligible.status, 200);
  assert.equal((await ineligible.json()).emailAccepted, false);
  assert.equal(deliveries.length, beforeResend);
});
}

for (const provider of ['resend', 'gmail']) {
test(`${provider}: missing configuration and rejected delivery fail without exposing or activating codes`, async t => {
  const email = `delivery-failure-${randomUUID()}@example.test`;
  const original = { ...process.env };
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });
  const request = (action: string) => POST(new Request('http://localhost/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-client-ip': email },
    body: JSON.stringify({ action, email, name: 'Failure Test', password: 'StrongPass123!' }),
  }));
  t.after(async () => {
    await cleanup(email);
    for (const key of ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'NODE_ENV', 'SMTP_USER', 'SMTP_PASS']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });
  delete process.env.RESEND_API_KEY;
  process.env.EMAIL_PROVIDER = 'resend';
  const missing = await request('register');
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /EMAIL_PROVIDER.*RESEND_API_KEY.*EMAIL_FROM/);
  assert.equal(await prisma.user.findUnique({ where: { email } }), null);
  process.env.EMAIL_PROVIDER = provider;
  process.env.NODE_ENV = 'development';
  process.env.SMTP_USER = 'sender@gmail.com';
  process.env.SMTP_PASS = 'abcdefghijklmnop';
  process.env.RESEND_API_KEY = 're_test_transport';
  process.env.EMAIL_FROM = provider === 'gmail' ? 'sender@gmail.com' : 'noreply@example.test';
  let undelivered = '';
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    undelivered = JSON.parse(String(init?.body)).text.match(/code is ([A-F0-9]{8})/)[1];
    return Response.json({ message: `Rejected email containing ${undelivered}` }, { status: 422 });
  });
  t.mock.method(nodemailer, 'createTransport', () => ({ close() {}, async sendMail(payload) {
    assert.equal(payload.to, email);
    undelivered = payload.text.match(/code is ([A-F0-9]{8})/)[1];
    throw Object.assign(new Error(`Authentication failed ${undelivered}`), { code: 'EAUTH' });
  } }));
  const failed = await request('register');
  assert.equal(failed.status, 502);
  const payload = await failed.json();
  assert.match(payload.error, /did not confirm sending/);
  assert.equal(JSON.stringify(payload).includes(undelivered), false);
  assert.equal(warnings.join(' ').includes(undelivered), false);
  assert.equal(await verifyEmail(email, undelivered), null);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  assert.equal(user.emailVerified, false);
  await assert.rejects(reissueVerificationCode(email, generateAccountCode()), VerificationCooldownError);
  await prisma.accountToken.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
  assert.equal((await request('resend-verification')).status, 502);
  assert.equal(await verifyEmail(email, undelivered), null);
});
}
