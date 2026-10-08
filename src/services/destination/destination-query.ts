import { countryForQuery, normalizeDestination } from './destination-index.ts';

export function parseDestinationQuery(query: string) {
  const parts = query.trim().split(',').map(value => value.trim()).filter(Boolean);
  let countryCode: string | undefined;
  let countryText = '';
  const last = parts.at(-1) || '';
  const words = last.split(/\s+/);
  for (let start = 0; start < words.length; start++) {
    const suffix = words.slice(start).join(' ');
    const code = countryForQuery(suffix);
    if (!code) continue;
    countryCode = code; countryText = suffix;
    parts[parts.length - 1] = words.slice(0, start).join(' ');
    break;
  }
  const remaining = parts.filter(Boolean);
  return { term: remaining.shift() || countryText || query.trim(), qualifiers: remaining, countryCode };
}

export function matchesQualifiers(qualifiers: string[], values: Array<string | undefined>) {
  const normalized = values.filter(Boolean).map(value => ` ${normalizeDestination(value!)} `);
  return qualifiers.every(qualifier => normalized.some(value => value.includes(` ${normalizeDestination(qualifier)} `)));
}
