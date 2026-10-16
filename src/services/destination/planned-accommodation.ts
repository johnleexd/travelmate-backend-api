import { z } from 'zod';
import { propertyPhotoSchema } from '../travel/hotel-quote.ts';
import type { DestinationAnchor } from '../itinerary/grounding-schema.ts';

// A named stay is a planning preference, not a reservation or price quote.
export const plannedAccommodationSchema = z.object({
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().max(300),
  type: z.string().trim().max(60).optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  photos: z.array(propertyPhotoSchema).max(5).optional(),
  rating: z.number().finite().min(0).max(5).optional(),
  amenities: z.array(z.string().max(100)).max(16).optional(),
  source: z.enum(['openstreetmap', 'manual', 'provider']),
  sourceId: z.string().max(200).regex(/^(?:osm:(?:node|way|relation):\d+|(?:liteapi|rapid):[a-z0-9]+(?::[a-z0-9_-]+)*)$/i).optional(),
}).strict().superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) context.addIssue({ code:'custom',path:['latitude'],message:'Provide both hotel coordinates or omit them.' });
  if (value.source === 'openstreetmap' && !/^osm:(node|way|relation):\d+$/.test(value.sourceId || '')) {
    context.addIssue({ code: 'custom', path: ['sourceId'], message: 'Select a mapped accommodation or enter it manually.' });
  }
  if (value.source === 'provider' && !/^(liteapi|rapid):[a-z0-9]+(?::[a-z0-9_-]+)*$/i.test(value.sourceId || '')) {
    context.addIssue({ code: 'custom', path: ['sourceId'], message: 'Select a provider accommodation or enter it manually.' });
  }
});
export type PlannedAccommodation = z.infer<typeof plannedAccommodationSchema>;

function distanceKm(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(second.latitude - first.latitude), dLon = radians(second.longitude - first.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(first.latitude)) * Math.cos(radians(second.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Use a verified selected stay as the day's travel origin without changing destination identity. */
export function activityPlanningAnchor(destination: DestinationAnchor, stay?: { latitude?: number; longitude?: number } | null): DestinationAnchor {
  if (!stay || !Number.isFinite(stay.latitude) || !Number.isFinite(stay.longitude)) return destination;
  const point = { latitude: Number(stay.latitude), longitude: Number(stay.longitude) };
  return distanceKm(destination, point) <= 30 ? { ...destination, ...point } : destination;
}
