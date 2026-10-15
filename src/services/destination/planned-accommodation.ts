import { z } from 'zod';
import { propertyPhotoSchema } from '../travel/hotel-quote.ts';

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
