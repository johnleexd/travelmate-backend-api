import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDestinationContext } from '../src/services/destination/destination-context-service.ts';

test('destination context resolves official currencies from selected country codes', () => {
  assert.equal(resolveDestinationContext('PH', 'Cebu City').currency, 'PHP');
  assert.equal(resolveDestinationContext('JP', 'Tokyo').currency, 'JPY');
  assert.equal(resolveDestinationContext('KR', 'Seoul').currency, 'KRW');
  assert.equal(resolveDestinationContext('FR', 'Paris').currency, 'EUR');
  assert.equal(resolveDestinationContext('US', 'New York').currency, 'USD');
  assert.equal(resolveDestinationContext('TH', 'Bangkok').currency, 'THB');
});

test('transport guidance is destination-specific and honestly labeled', () => {
  const cebu = resolveDestinationContext('PH', 'Cebu City');
  const tokyo = resolveDestinationContext('JP', 'Tokyo');
  assert.ok(cebu.transportation.some((mode) => mode.id === 'jeepney'));
  assert.ok(cebu.transportation.some((mode) => mode.id === 'ferry'));
  assert.equal(tokyo.transportation.some((mode) => mode.id === 'jeepney'), false);
  assert.ok(tokyo.transportation.some((mode) => mode.id === 'train'));
  assert.match(tokyo.transportationMessage, /not live/i);
});

test('unsupported destinations return explicit manual fallback states', () => {
  const context = resolveDestinationContext('ZZ', 'Unknown');
  assert.equal(context.currency, null);
  assert.deepEqual(context.transportation, []);
  assert.equal(context.transportationSource, 'unavailable');
});

