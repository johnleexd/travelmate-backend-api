import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateEqualShares, formatMoney, hasValidCurrencyPrecision, normalizeCurrency } from '../src/schemas/domain.ts';

test('trip currencies normalize to the supported ISO codes', () => {
  assert.equal(normalizeCurrency(' usd '), 'USD');
  assert.equal(normalizeCurrency('jpy'), 'JPY');
  assert.equal(normalizeCurrency('krw'), 'KRW');
  assert.equal(normalizeCurrency('thb'), 'THB');
  assert.throws(() => normalizeCurrency('XYZ'), /PHP, USD, EUR, JPY/);
});

test('money formatting always includes its currency code', () => {
  assert.match(formatMoney(1234.5, 'USD'), /USD\s*1,234\.50/);
  assert.match(formatMoney(1234, 'JPY'), /JPY\s*1,234/);
});

test('cost sharing preserves decimal budgets in currency minor units', () => {
  const shares = allocateEqualShares(1000.50, 3, 'USD');
  assert.deepEqual(shares, [333.50, 333.50, 333.50]);
  assert.equal(shares.reduce((sum, amount) => sum + amount, 0), 1000.50);
  assert.deepEqual(allocateEqualShares(10_000, 3, 'JPY'), [3334, 3333, 3333]);
  assert.equal(hasValidCurrencyPrecision(1000.50, 'USD'), true);
  assert.equal(hasValidCurrencyPrecision(1000.505, 'USD'), false);
  assert.equal(hasValidCurrencyPrecision(1000.50, 'JPY'), false);
});
