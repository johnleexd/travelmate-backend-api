import { createHash } from 'node:crypto';
import type { DayActivity, ItineraryResponse } from '../../controllers/itinerary-controller.ts';
export type ActivityStatus = 'planned' | 'completed' | 'skipped' | 'rescheduled';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function tripRevision(trip: { id: string; itinerary: unknown; updatedAt?: string | Date }) {
  return createHash('sha256').update(canonical([trip.id, trip.itinerary, trip.updatedAt instanceof Date ? trip.updatedAt.toISOString() : trip.updatedAt])).digest('hex');
}
export function activityIdentity(tripId: string, date: string, index: number, activity: Pick<DayActivity, 'id' | 'title' | 'location' | 'place'>): string {
  return activity.id || 'activity-' + createHash('sha256').update(canonical([tripId, date, index, activity.title, activity.location, activity.place?.placeId])).digest('hex').slice(0, 24);
}
/** Lazy identifiers keep legacy reads read-only; the first confirmed update persists them. */
export function managedItinerary(tripId: string, value: unknown): ItineraryResponse {
  if (!value || typeof value !== 'object' || !Array.isArray((value as ItineraryResponse).days)) throw new Error('This saved trip has no editable daily itinerary.');
  const plan = structuredClone(value as ItineraryResponse), ids = new Set<string>();
  plan.days.forEach(day => day.activities.forEach((activity, index) => {
    activity.id = activityIdentity(tripId, day.date, index, activity);
    if (ids.has(activity.id)) throw new Error('This itinerary has conflicting activity identifiers.');
    ids.add(activity.id); activity.status ??= 'planned';
  }));
  return plan;
}
export function recordActivityChange(activity: DayActivity, action: 'complete' | 'skip' | 'plan' | 'edit' | 'reschedule' | 'replan', fromDate: string, toDate: string, toTime: string, now = new Date().toISOString()): Pick<DayActivity, 'id' | 'status' | 'statusChangedAt' | 'time' | 'managementHistory'> {
  const status: ActivityStatus = action === 'complete' ? 'completed' : action === 'skip' ? 'skipped' : action === 'plan' ? 'planned' : action === 'reschedule' || action === 'replan' ? 'rescheduled' : activity.status || 'planned';
  if ((activity.managementHistory?.length || 0) >= 500) throw new Error('This activity has reached its history limit. Its records remain available in version history.');
  return { id: activity.id, status, statusChangedAt: now, time: toTime, managementHistory: [...(activity.managementHistory || []), { action, status, at: now, fromDate, fromTime: activity.time, toDate, toTime }] };
}
