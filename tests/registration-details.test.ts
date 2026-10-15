import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registrationDetails, RegistrationValidationError } from '../src/schemas/auth/registration-schema.ts';
import { registerUser, authenticateUser } from '../src/services/auth/auth-service.ts';
import { prisma } from '../src/lib/prisma.ts';

after(() => prisma.$disconnect());

test('registration combines trimmed name parts and normalizes optional Philippine mobile numbers', () => {
  assert.deepEqual(registrationDetails({ firstName: ' Mary Jane ', lastName: " O’Neill-Santos ", phone: ' +63 (912) 345-6789 ' }), { name: 'Mary Jane O’Neill-Santos', phone: '+639123456789' });
  assert.deepEqual(registrationDetails({ firstName: '李', lastName: '明', phone: '   ' }), { name: '李 明' });
  assert.deepEqual(registrationDetails({ name: 'Existing Client' }), { name: 'Existing Client' });
});

test('registration rejects missing name parts, excessive length and malformed contact numbers', () => {
  for (const input of [
    { firstName: 'First' }, { lastName: 'Last' }, { firstName: ' ', lastName: 'Last' }, { firstName: {}, lastName: 'Last' },
    { firstName: 'a'.repeat(40), lastName: 'b'.repeat(40) }, { name: 'a'.repeat(81) },
    { name: 'Valid Name', phone: 123 }, { name: 'Valid Name', phone: 'call me' }, { name: 'Valid Name', phone: '+---' }, { name: 'Valid Name', phone: '1'.repeat(31) },
    { name: 'Valid Name', phone: '91712345678' }, { name: 'Valid Name', phone: '+649171234567' }, { name: 'Valid Name', phone: '912' },
  ]) assert.throws(() => registrationDetails(input), RegistrationValidationError);
});

test('registration writes contact details with the account and returns them on later sign-in', async t => {
  let stored: Record<string, unknown> = {};
  const transaction = prisma.$transaction;
  const findUnique = prisma.user.findUnique;
  Reflect.set(prisma, '$transaction', t.mock.fn(async (run: (transaction: unknown) => Promise<unknown>) => run({
    user: { create: async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...data, id: 'registration-fixture', createdAt: new Date(), bio: null, avatarUrl: null };
      return stored;
    } }, accountToken: { create: async () => ({}) },
  })));
  Reflect.set(prisma.user, 'findUnique', t.mock.fn(async () => stored));
  t.after(() => { Reflect.set(prisma, '$transaction', transaction); Reflect.set(prisma.user, 'findUnique', findUnique); });
  const details = registrationDetails({ firstName: 'Test', lastName: 'Traveler', phone: '+63 912 345 6789' });
  const user = await registerUser({ ...details, email: 'registration@example.test', rawPassword: 'FixturePassword123!', role: 'traveler', verificationCode: 'A1B2C3D4' });
  assert.equal(stored.name, 'Test Traveler');
  assert.equal(stored.phone, '+639123456789');
  assert.notEqual(stored.passwordHash, 'FixturePassword123!');
  assert.equal(user.phone, stored.phone);
  assert.equal(user.emailVerified, false);
  assert.equal(JSON.stringify(user).includes('FixturePassword123!'), false);
  const authenticated = await authenticateUser('registration@example.test', 'FixturePassword123!');
  assert.equal(authenticated?.phone, '+639123456789');
  assert.equal(authenticated?.name, 'Test Traveler');
});
