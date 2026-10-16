// Keep the original persisted style values compatible with older clients/trips.
export const TRAVEL_STYLE_OPTIONS = [
  { value: 'budget', label: 'Budget' },
  { value: 'balanced', label: 'Balanced / Mixed' },
  { value: 'comfort', label: 'Comfort' },
  { value: 'luxury', label: 'Luxury' },
  { value: 'family-friendly', label: 'Family-friendly' },
] as const;
// Older trips can contain three distinct lists of up to twenty entries each.
export const MAX_INTERESTS = 60;
export const MAX_INTEREST_LENGTH = 200;
export const MAX_INTEREST_INPUT_LENGTH = MAX_INTERESTS * (MAX_INTEREST_LENGTH + 2);

export function normalizeInterests(...sources: (string | readonly string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  return sources.flatMap(source => typeof source === 'string' ? source.split(',') : source ?? [])
    .map(value => value.trim()).filter(value => {
      const key = value.normalize('NFKC').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function interestsValidationMessage(values: readonly string[]): string {
  if (values.length > MAX_INTERESTS) return `Use at most ${MAX_INTERESTS} comma-separated interests or activities.`;
  if (values.some(value => value.length > MAX_INTEREST_LENGTH)) return `Keep each interest or activity within ${MAX_INTEREST_LENGTH} characters.`;
  return '';
}
