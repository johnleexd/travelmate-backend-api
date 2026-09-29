import assert from 'node:assert/strict';
import test from 'node:test';
import { sendUserWarning, validateWarning } from '../src/services/platform/user-warning-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

test('warnings require a recipient and a bounded meaningful message', () => {
  assert.deepEqual(validateWarning({ id: ' traveler ', message: ' Please stop submitting duplicate reports. ' }), { id: 'traveler', message: 'Please stop submitting duplicate reports.' });
  for (const body of [{}, { id: 'u', message: '   ' }, { id: 'u', message: 'short' }, { id: 'u', message: 'x'.repeat(2001) }]) assert.throws(() => validateWarning(body));
});
test('travelers cannot send warnings', async () => {
  await assert.rejects(() => sendUserWarning({ role: 'traveler' } as PublicUser, { id: 'u', message: 'Please review your recent activity.' }), /Only admins/);
});
