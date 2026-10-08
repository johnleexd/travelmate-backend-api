import { z } from 'zod';

// A named stay is a planning preference, not a reservation or price quote.
export const plannedAccommodationSchema = z.object({
  name: z.string().trim().min(1).max(150),
  address: z.string().trim().max(300),
  type: z.string().trim().max(60).optional(),
  source: z.enum(['openstreetmap', 'manual', 'provider']),
  sourceId: z.string().max(200).regex(/^(?:osm:(?:node|way|relation):\d+|(?:liteapi|rapid):[a-z0-9]+(?::[a-z0-9_-]+)*)$/i).optional(),
}).strict().superRefine((value, context) => {
  if (value.source === 'openstreetmap' && !/^osm:(node|way|relation):\d+$/.test(value.sourceId || '')) {
    context.addIssue({ code: 'custom', path: ['sourceId'], message: 'Select a mapped accommodation or enter it manually.' });
  }
  if (value.source === 'provider' && !/^(liteapi|rapid):[a-z0-9]+(?::[a-z0-9_-]+)*$/i.test(value.sourceId || '')) {
    context.addIssue({ code: 'custom', path: ['sourceId'], message: 'Select a provider accommodation or enter it manually.' });
  }
});
export type PlannedAccommodation = z.infer<typeof plannedAccommodationSchema>;
