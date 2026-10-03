import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseConnectionError, retryDatabaseOperation } from '../src/lib/database-retry.ts';

test('OAuth retries a transient database connection failure', async () => {
  let attempts = 0;
  const result = await retryDatabaseOperation(async () => {
    attempts++;
    if (attempts === 1) throw { code: 'P1001' };
    return 'connected';
  });
  assert.equal(result, 'connected');
  assert.equal(attempts, 2);
});

test('OAuth does not retry non-connection failures', async () => {
  let attempts = 0;
  const error = new Error('invalid state');
  await assert.rejects(() => retryDatabaseOperation(async () => {
    attempts++;
    throw error;
  }), error);
  assert.equal(attempts, 1);
  assert.equal(isDatabaseConnectionError({ code: 'P2010', meta: { code: 'ETIMEDOUT' } }), true);
});

test('OAuth reports access-denied connections without retrying them', async () => {
  let attempts = 0;
  await assert.rejects(() => retryDatabaseOperation(async () => {
    attempts++;
    throw { code: 'EACCES' };
  }));
  assert.equal(attempts, 1);
  assert.equal(isDatabaseConnectionError({ code: 'EACCES' }), true);
});

test('nested Prisma driver errors recover but invalid credentials and constraints are not retried', async () => {
  let attempts = 0;
  assert.equal(await retryDatabaseOperation(async () => {
    if (++attempts === 1) throw { meta: { driverAdapterError: { cause: { kind: 'ConnectionClosed' } } } };
    return 'recovered';
  }), 'recovered');
  assert.equal(attempts, 2);
  for (const code of ['P1000', 'P2002']) {
    attempts = 0;
    await assert.rejects(() => retryDatabaseOperation(async () => { attempts++; throw { code }; }));
    assert.equal(attempts, 1);
  }
});

test('uncoded pg connection timeouts recover and retry exhaustion preserves the error', async () => {
  const failure = new Error('Connection terminated due to connection timeout');
  let attempts = 0;
  const result = await retryDatabaseOperation(async () => {
    if (++attempts === 1) throw failure;
    return 'connected';
  });
  assert.equal(result, 'connected');
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(() => retryDatabaseOperation(async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 3);
});
