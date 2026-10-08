import { demoSeedPasswords } from '../../src/services/auth/demo-seed-policy.ts';

export function demoPassword(role: 'traveler' | 'admin'): string {
  return demoSeedPasswords(process.env)[role];
}
