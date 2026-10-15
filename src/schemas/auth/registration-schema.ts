export class RegistrationValidationError extends Error {}

export function registrationDetails(input: Record<string, unknown>): { name: string; phone?: string } {
  let name: string;
  if (input.firstName !== undefined || input.lastName !== undefined) {
    if (typeof input.firstName !== 'string' || !input.firstName.trim()) throw new RegistrationValidationError('Enter your first name.');
    if (typeof input.lastName !== 'string' || !input.lastName.trim()) throw new RegistrationValidationError('Enter your last name.');
    name = `${input.firstName.trim()} ${input.lastName.trim()}`;
  } else {
    // Existing clients can keep sending the single display-name field.
    if (typeof input.name !== 'string') throw new RegistrationValidationError('Full name must contain at least 2 characters.');
    name = input.name.trim();
  }
  if (name.length < 2 || name.length > 80) throw new RegistrationValidationError('Name must be between 2 and 80 characters.');
  if (input.phone !== undefined && typeof input.phone !== 'string') throw new RegistrationValidationError('Contact number must be text.');
  const phone = normalizePhilippineMobile(typeof input.phone === 'string' ? input.phone : '');
  if (phone === null) throw new RegistrationValidationError('Enter a 10-digit Philippine mobile number (e.g. 917 123 4567).');
  return { name, ...(phone ? { phone } : {}) };
}
import { normalizePhilippineMobile } from './philippine-mobile.ts';

