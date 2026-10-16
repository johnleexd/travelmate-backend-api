import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import app from '../src/app.ts';
import { prisma } from '../src/lib/prisma.ts';
import { verifyPaymongoTestSignature } from '../src/routes/paymongo-webhook-routes.ts';

const secret = 'whsk_test_fixture_only';
const body = JSON.stringify({ data: { id: 'evt_fixture', type: 'event', attributes: { type: 'payment.paid', livemode: false, data: { attributes: { billing: { email: 'private@example.test' } } } } } });
const signature = (raw: string, time = Math.floor(Date.now() / 1000), key = secret) => `t=${time},te=${createHmac('sha256', key).update(`${time}.${raw}`).digest('hex')},li=`;
const server = app.listen(0, '127.0.0.1');
const listening = new Promise<void>(resolve => server.on('listening', resolve));
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });

test('PayMongo signature uses original bytes, test signature and a bounded timestamp', () => {
  const bytes = Buffer.from(body), header = signature(body);
  assert.equal(verifyPaymongoTestSignature(bytes, header, secret), true);
  assert.equal(verifyPaymongoTestSignature(Buffer.from(body + ' '), header, secret), false);
  assert.equal(verifyPaymongoTestSignature(bytes, header, 'wrong-secret'), false);
  assert.equal(verifyPaymongoTestSignature(bytes, signature(body, Math.floor(Date.now() / 1000) - 301), secret), false);
  assert.equal(verifyPaymongoTestSignature(bytes, signature(body, Math.floor(Date.now() / 1000) + 600), secret), false);
  assert.equal(verifyPaymongoTestSignature(bytes, header.replace('te=', 'li='), secret), false);
  assert.equal(verifyPaymongoTestSignature(bytes, header + ',te=' + '0'.repeat(64), secret), false);
  assert.equal(verifyPaymongoTestSignature(bytes, 't=invalid,te=invalid', secret), false);
});

test('running API accepts only signed test receipts without changing plans or financial records', async t => {
  await listening;
  const keys = ['PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET', 'NODE_ENV', 'PAYMONGO_TEST_CHECKOUT_ENABLED'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  Object.assign(process.env, { PAYMONGO_SECRET_KEY: 'sk_test_fixture_only', PAYMONGO_WEBHOOK_SECRET: secret, NODE_ENV: 'test', PAYMONGO_TEST_CHECKOUT_ENABLED: 'false' });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/paymongo`;
  const send = (raw = body, header: string | undefined = signature(raw), contentType = 'application/json') => fetch(url, { method: 'POST', headers: { 'Content-Type': contentType, 'X-Forwarded-Proto': 'https', ...(header ? { 'Paymongo-Signature': header } : {}) }, body: raw });
  const logs: string[] = [];
  t.mock.method(console, 'info', (...values: unknown[]) => { logs.push(values.map(String).join(' ')); });
  for (const model of [prisma.planSubscription, prisma.paymentTransaction, prisma.trip, prisma.planActivation]) {
    for (const method of ['create', 'update', 'upsert'] as const) {
      const original = Reflect.get(model, method);
      Reflect.set(model, method, async () => { throw new Error('Receipt testing must not mutate application data.'); });
      t.after(() => Reflect.set(model, method, original));
    }
  }
  const accepted = await send();
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { received: true, mode: 'test', action: 'acknowledged_only' });
  assert.equal((await send()).status, 200); // Duplicate deliveries have no effects.
  assert.equal((await send(body, '')).status, 401);
  assert.equal((await send(body, signature(body, undefined, 'wrong'))).status, 401);
  assert.equal((await send(body + ' ', signature(body))).status, 401);
  assert.equal((await send(body.replace('"livemode":false', '"livemode":true'))).status, 400);
  assert.equal((await send(body.replace('"livemode":false,', ''))).status, 400);
  assert.equal((await send('{not json}')).status, 400);
  assert.equal((await send(body, signature(body), 'text/plain')).status, 415);
  assert.equal((await send(' '.repeat(129 * 1024))).status, 413);
  assert.equal((await fetch(url)).status, 405);
  delete process.env.PAYMONGO_WEBHOOK_SECRET;
  assert.equal((await send()).status, 503);
  process.env.PAYMONGO_WEBHOOK_SECRET = secret;
  process.env.PAYMONGO_SECRET_KEY = 'sk_live_fixture_only';
  assert.equal((await send()).status, 503);
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_fixture_only'; process.env.NODE_ENV = 'production';
  assert.equal((await send()).status, 503);
  assert.ok(logs.some(line => line.includes('paymongo_test_webhook_received')));
  assert.ok(logs.every(line => !line.includes(secret) && !line.includes('private@example.test') && !line.includes('sk_test_')));
});
