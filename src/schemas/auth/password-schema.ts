export const STRONG_PASSWORD_PATTERN = /^(?=.{8,64}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S+$/;

export const STRONG_PASSWORD_REQUIREMENTS =
  "Password must be 8–64 characters and include an uppercase letter, a lowercase letter, a number, and a special character, with no spaces.";

export function isStrongPassword(password: string): boolean {
  return STRONG_PASSWORD_PATTERN.test(password);
}

export function getPasswordValidationError(password: string): string | null {
  if (!password) return 'Password is required.';
  if (password.length < 8 || password.length > 64) return 'Password must contain 8–64 characters.';
  if (/\s/.test(password)) return 'Password must not contain spaces or other whitespace.';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
  if (!/\d/.test(password)) return 'Password must include a number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a special character.';
  return null;
}
