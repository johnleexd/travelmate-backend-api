import assert from 'node:assert/strict';
import test from 'node:test';
import { isDatabaseConnectionError, retryOAuthDatabaseOperation } from '../src/services/auth/oauth-database-retry.ts';

test('OAuth retries a transient database connection failure', async () => {
  let attempts = 0;
  const result = await retryOAuthDatabaseOperation(async () => {
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
  await assert.rejects(() => retryOAuthDatabaseOperation(async () => {
    attempts++;
    throw error;
  }), error);
  assert.equal(attempts, 1);
  assert.equal(isDatabaseConnectionError({ code: 'P2010', meta: { code: 'ETIMEDOUT' } }), true);
});

test('OAuth reports access-denied connections without retrying them', async () => {
  let attempts = 0;
  await assert.rejects(() => retryOAuthDatabaseOperation(async () => {
    attempts++;
    throw { code: 'EACCES' };
  }));
  assert.equal(attempts, 1);
  assert.equal(isDatabaseConnectionError({ code: 'EACCES' }), true);
});
