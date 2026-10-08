import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { POST } from '../src/controllers/auth-controller.ts';
import { prisma } from '../src/lib/prisma.ts';
import { emailConfigurationIssues } from '../src/services/email/email-provider.ts';

after(() => prisma.$disconnect());

test('email configuration reports variable names and detects placeholder settings', () => {
  assert.deepEqual(emailConfigurationIssues({}), ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM']);
  assert.deepEqual(emailConfigurationIssues({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'your_key', EMAIL_FROM: 'noreply@your-verified-domain.example' }), ['RESEND_API_KEY', 'EMAIL_FROM']);
  assert.deepEqual(emailConfigurationIssues({ EMAIL_PROVIDER: ' resend ', RESEND_API_KEY: 're_test', EMAIL_FROM: 'noreply@example.test' }), []);
});

test('unconfigured registration fails without account persistence or claiming email was sent', async t => {
  const keys = ['NODE_ENV', 'EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'development';
  for (const key of keys.slice(1)) delete process.env[key];
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const original = prisma.$queryRaw;
  Reflect.set(prisma, '$queryRaw', t.mock.fn(async () => [{ count: 1, reset_at: new Date() }]));
  t.after(() => Reflect.set(prisma, '$queryRaw', original));
  t.mock.method(Math, 'random', () => 1);
  const transaction = prisma.$transaction;
  const persisted = t.mock.fn(() => { throw new Error('Missing email configuration must not create an account.'); });
  Reflect.set(prisma, '$transaction', persisted);
  t.after(() => Reflect.set(prisma, '$transaction', transaction));
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const response = await POST(new Request('http://localhost/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-request-id': 'config-test-request' },
    body: JSON.stringify({ action: 'register', name: 'Configuration Test', email: 'config@example.test', password: 'PrivatePassword123!', confirmPassword: 'PrivatePassword123!' }),
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.retryable, false);
  assert.equal(body.details.reason, 'configuration_required');
  assert.deepEqual(body.details.missingVariables, keys.slice(1));
  assert.match(body.error, /No verification email was sent/);
  assert.equal(persisted.mock.callCount(), 0);
  assert.equal('verificationCode' in body, false);
  assert.equal(warnings.join(' ').includes('PrivatePassword123!'), false);
  assert.equal(warnings.join(' ').includes('config@example.test'), false);
  assert.equal(JSON.parse(warnings[0]).operation, 'email_configuration');
});
