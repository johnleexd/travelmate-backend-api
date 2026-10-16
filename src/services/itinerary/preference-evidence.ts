import { normalizeInterests } from '../../lib/trip-preferences.ts';
import type { GroundedPlace } from './grounded-places.ts';

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const broadInterests: Record<string, RegExp> = {
  food: /\b(food|market|restaurant|cuisine)\b/, 'local food': /\b(food|market|restaurant|cuisine)\b/,
  nature: /\b(park|garden|beach|forest|mountain)\b/, culture: /\b(museum|gallery|heritage|temple|church)\b/,
  history: /\b(museum|historic|heritage|castle|palace|fortress)\b/, sightseeing: /./,
};

export function preferenceMatchesPlace(request: string, place: GroundedPlace): boolean {
  const preference = normalized(request);
  const source = normalized(`${place.name} ${place.description}`);
  if (broadInterests[preference]) return broadInterests[preference].test(source);
  // Specific requests need their own source evidence. A beach alone does not
  // establish snorkeling, equipment hire, operators, or seasonal availability.
  const words = preference.split(' ').filter(word => !['a', 'an', 'the', 'visit', 'visiting'].includes(word));
  return words.length > 0 && words.every(word => source.split(' ').includes(word));
}

export function preferenceLimitations(interests: string[], activities: string[], places: GroundedPlace[], scheduledIds: Set<string>): string[] {
  const requests = normalizeInterests(interests, activities);
  const unsupported = requests.filter(request => !places.some(place => preferenceMatchesPlace(request, place)));
  const unscheduled = requests.filter(request => !unsupported.includes(request) && !places.some(place => scheduledIds.has(place.placeId) && preferenceMatchesPlace(request, place)));
  const names = (values: string[]) => values.slice(0, 3).map(value => `“${value.slice(0, 160)}”`).join(', ') + (values.length > 3 ? ` and ${values.length - 3} other requests` : '');
  const alternatives = places.filter(place => scheduledIds.has(place.placeId)).slice(0, 2).map(place => place.name.slice(0, 100));
  return [
    ...(unsupported.length ? [`Source data does not establish availability for ${names(unsupported)}. ${alternatives.length ? `Consider the source-supported visits to ${alternatives.join(' or ')} as alternatives` : 'Try broader interests or another destination with verified place coverage'}; confirm activity access, operators, dates and prices before travel.`] : []),
    ...(unscheduled.length ? [`Source-related places for ${names(unscheduled)} could not be included within the available dates, transfer time, spending limit or visit capacity. Consider the suggested visits, revise your preferences or dates, or confirm other suitable options locally.`] : []),
  ];
}
