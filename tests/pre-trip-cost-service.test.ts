import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePreTripCosts } from '../src/services/budget/pre-trip-cost-service.ts';

test('normalizes global user-entered pre-trip costs into one committed total', () => {
  const result = normalizePreTripCosts({
    startingLocation: 'Cordova, Cebu, Philippines', departureAirport: 'Mactan-Cebu International Airport',
    passportCountry: 'Philippines', passportStatus: 'needs_renewal', airportTransferOutbound: 600,
    airportTransferReturn: 600, passport: 950, visaOrAuthorization: 0, departureTaxes: 1620,
    insurance: 800, other: 200,
  }, 'PHP');
  assert.equal(result?.total, 4770);
  assert.equal(result?.source, 'user-entered-estimate');
});

test('supports non-Philippine locations and currency precision', () => {
  const result = normalizePreTripCosts({ startingLocation: 'Austin, Texas, USA', passportCountry: 'United States', airportTransferOutbound: 42.5, airportTransferReturn: 40, insurance: 89.99 }, 'USD');
  assert.equal(result?.total, 172.49);
});

test('rejects invalid or negative pre-trip amounts', () => {
  assert.throws(() => normalizePreTripCosts({ passport: -1 }, 'USD'), /valid non-negative USD amount/);
  assert.throws(() => normalizePreTripCosts({ passport: 1.5 }, 'JPY'), /valid non-negative JPY amount/);
});
