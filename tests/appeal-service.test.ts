import assert from 'node:assert/strict';
import test from 'node:test';
import { appealMessage, submitAppeal, reviewAppeal } from '../src/services/platform/appeal-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

test('appeal messages are trimmed and bounded', () => {
  assert.equal(appealMessage('  Please review my suspension.  '), 'Please review my suspension.');
  for (const value of [null, '', 'short', ' '.repeat(12), 'x'.repeat(2001)]) assert.throws(() => appealMessage(value));
});
test('appeal actions enforce roles and account states before persistence', async () => {
  const traveler = { id: 'test', role: 'traveler', accountStatus: 'active' } as PublicUser;
  await assert.rejects(() => submitAppeal(traveler, { message: 'Please review my suspension.' }), /Only suspended/);
  await assert.rejects(() => submitAppeal({ ...traveler, role: 'admin', accountStatus: 'suspended' }, {}), /Only suspended/);
  await assert.rejects(() => reviewAppeal({ ...traveler, accountStatus: 'suspended' }, { id: 'test', decision: 'approved' }), /Only admins/);
  await assert.rejects(() => reviewAppeal({ ...traveler, role: 'admin' }, { id: 'test', decision: 'invalid', message: 'Please review my suspension.' }), /valid decision/);
});
