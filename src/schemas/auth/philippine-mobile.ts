export function normalizePhilippineMobile(input: string): string | null {
  const value = input.trim();
  if (!value) return '';
  if (!/^\+?[0-9\s().-]*$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (value.startsWith('+')) {
    if (!digits.startsWith('63')) return null;
    digits = digits.slice(2);
  } else if (digits.startsWith('63') && digits.length >= 12) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return /^[89]\d{9}$/.test(digits) ? '+63' + digits : null;
}
