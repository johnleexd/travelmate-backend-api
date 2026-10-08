import { isStrongPassword } from '../../schemas/auth/password-schema.ts';

export function demoSeedPasswords(environment: NodeJS.ProcessEnv): { admin: string; traveler: string } {
  if (environment.NODE_ENV === 'production' || environment.TRAVELMATE_ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Demo seeding is disabled. It requires a non-production environment and TRAVELMATE_ALLOW_DEMO_SEED=true.');
  }
  const admin = environment.DEMO_ADMIN_PASSWORD || '';
  const traveler = environment.DEMO_TRAVELER_PASSWORD || '';
  if ([admin, traveler].some(value => value.length < 16 || !isStrongPassword(value) || value === 'Travel123!') || admin === traveler) {
    throw new Error('Set distinct DEMO_ADMIN_PASSWORD and DEMO_TRAVELER_PASSWORD values of 16–64 characters that meet the password requirements.');
  }
  return { admin, traveler };
}
