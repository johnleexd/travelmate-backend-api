export const STRONG_PASSWORD_PATTERN = /^(?=.{8,64}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])\S+$/;

export const STRONG_PASSWORD_REQUIREMENTS =
  "Password must be 8–64 characters and include an uppercase letter, a lowercase letter, a number, and a special character, with no spaces.";

export function isStrongPassword(password: string): boolean {
  return STRONG_PASSWORD_PATTERN.test(password);
}
