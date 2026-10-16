import type { DestinationAnchor } from './grounding-schema.ts';
import type { GroundedPlace } from './grounded-places.ts';

/**
 * Small, reviewed provider snapshots keep a plan useful when live reference
 * providers return sparse results or are temporarily unavailable. Every entry
 * retains its Wikidata identity and coordinates. The scheduler still applies
 * distance, destination and interest checks, and the resulting itinerary
 * labels these records as stale cached data.
 */
const tokyoCultureSnapshot: GroundedPlace[] = [
  ['Q1534481', 'Gokoku-ji Temple', 'Buddhist temple in Tokyo, Japan', 35.72175, 139.72563889, '5-40-1 Otsuka, Bunkyo City, Tokyo'],
  ['Q776863', 'Shinjuku Gyoen', 'park and garden in Shinjuku and Shibuya, Tokyo, Japan', 35.685, 139.71, 'Not available'],
  ['Q5364883', 'Shinjuku Central Park', 'public park in Shinjuku, Tokyo, Japan', 35.69007, 139.68947, '2-11 Nishi-Shinjuku, Shinjuku City, Tokyo'],
  ['Q1047097', 'Nezu Museum', 'art museum in Tokyo, Japan', 35.66215, 139.71703, 'Not available'],
  ['Q3329572', 'Yamatane Museum of Art', 'art museum in Tokyo, Japan', 35.6532, 139.7137, 'Not available'],
  ['Q1048740', 'Ancient Orient Museum', 'archaeology and art museum in Tokyo, Japan', 35.728534, 139.720785, 'Not available'],
  ['Q3425473', 'Renko-ji Temple', 'Buddhist temple in Tokyo, Japan', 35.6956, 139.6549, '3-30-20 Wada, Suginami City, Tokyo'],
  ['Q1362638', 'National Art Center, Tokyo', 'art museum and exhibition center in Tokyo, Japan', 35.66528, 139.72634, 'Not available'],
  ['Q728781', 'Eisei Bunko Museum', 'art and history museum in Tokyo, Japan', 35.713171, 139.723296, '1-1-1 Mejirodai, Bunkyo City, Tokyo'],
  ['Q3915469', 'Watari Museum of Contemporary Art', 'contemporary art museum in Tokyo, Japan', 35.670695, 139.713365, 'Not available'],
  ['Q6810040', 'Meiji Shrine Inner Garden', 'historic public garden at Meiji Shrine in Shibuya, Tokyo, Japan', 35.672791, 139.700352, 'Not available'],
  ['Q2855971', 'Yushukan Museum', 'military and history museum in Tokyo, Japan', 35.695382, 139.743264, 'Not available'],
  ['Q3789149', 'Japanese Folk Crafts Museum', 'folk art museum in Tokyo, Japan', 35.66083333, 139.67916667, 'Not available'],
  ['Q994083', 'Printing Museum', 'museum of printing and graphic culture in Tokyo, Japan', 35.70933333, 139.74161111, '1-3-3 Suido, Bunkyo City, Tokyo'],
].map(([placeId, name, description, latitude, longitude, address]) => ({
  provider: 'wikidata' as const,
  placeId: String(placeId), name: String(name), description: String(description),
  latitude: Number(latitude), longitude: Number(longitude), city: 'Tokyo', country: 'Japan', countryCode: 'JP',
  sourceUrl: `https://www.wikidata.org/wiki/${placeId}`,
  fetchedAt: '2026-10-11T00:00:00.000Z',
  openingHours: 'Opening hours need confirmation', address: String(address),
}));

const snapshots = [{ city: 'Tokyo', countryCode: 'JP', latitude: 35.6895, longitude: 139.69171, places: tokyoCultureSnapshot }];
const normalized = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function verifiedPlaceSnapshot(anchor: DestinationAnchor): GroundedPlace[] {
  const snapshot = snapshots.find(entry => entry.countryCode === anchor.countryCode && normalized(entry.city) === normalized(anchor.city)
    && Math.abs(entry.latitude - anchor.latitude) < 0.1 && Math.abs(entry.longitude - anchor.longitude) < 0.1);
  return snapshot?.places.map(place => ({ ...place })) ?? [];
}
