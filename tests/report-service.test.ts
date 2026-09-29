import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReport, resolveReport, submitReport } from '../src/services/platform/report-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

const traveler: PublicUser = { id: 'test', name: 'Traveler', email: 'test@example.test', role: 'traveler', emailVerified: true, profileStatus: 'unverified', accountStatus: 'active', trustScore: 50 };
test('reports require bounded subjects and useful details', () => {
  assert.deepEqual(validateReport({ title: '  Saved trip issue  ', details: '  My saved trip will not open.  ' }), { title: 'Saved trip issue', details: 'My saved trip will not open.' });
  for (const body of [{}, { title: 'Short', details: 'x' }, { title: 'x'.repeat(121), details: 'Detailed issue' }, { title: 'Subject', details: 'x'.repeat(2001) }]) assert.throws(() => validateReport(body));
});
test('report roles are enforced before persistence', async () => {
  await assert.rejects(() => resolveReport(traveler, { id: 'report' }), /Only admins/);
  await assert.rejects(() => submitReport({ ...traveler, role: 'admin' }, { title: 'Subject', details: 'Detailed issue' }), /Only travelers/);
});
