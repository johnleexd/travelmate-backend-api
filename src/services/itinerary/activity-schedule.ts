type ScheduledActivity = { time: string; title: string; durationMinutes?: number; travelMinutes?: number; place?: { latitude: number; longitude: number } };
export function timeMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(value.trim());
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) return null;
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return hour * 60 + minute;
}
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export function transferMinutes(previous: ScheduledActivity | undefined, activity: ScheduledActivity): number {
  if (!previous) return 0;
  let minimum = 15;
  if (previous.place && activity.place) {
    const a = previous.place, b = activity.place, rad = Math.PI / 180;
    const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
    minimum = Math.ceil(6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h))) / 4 * 60) + 15;
  }
  return Math.max(minimum, activity.travelMinutes ?? 0);
}
export function validateActivitySchedule<T extends ScheduledActivity>(activities: T[]): T[] {
  let previous: T | undefined, finish: number | null = null;
  return activities.map(activity => {
    const start = timeMinutes(activity.time);
    if (activity.durationMinutes !== undefined && (!Number.isInteger(activity.durationMinutes) || activity.durationMinutes < 15 || activity.durationMinutes > 720)) throw new Error('Visit duration must be between 15 and 720 minutes.');
    if (activity.travelMinutes !== undefined && (!Number.isInteger(activity.travelMinutes) || activity.travelMinutes < 0 || activity.travelMinutes > 480)) throw new Error('Travel buffer must be between 0 and 480 minutes.');
    if (activity.durationMinutes !== undefined && start === null && !['flexible', 'daily allowance'].includes(activity.time.trim().toLowerCase())) throw new Error('Enter a valid time, such as 09:00 or 02:30 PM, or use Flexible.');
    if (start === null) return activity; // Daily allowances have no scheduled time slot.
    const transfer = transferMinutes(previous, activity);
    if (finish !== null && start < finish + transfer) throw new Error(`“${activity.title}” overlaps the previous visit or its travel buffer. Move it later or reduce the duration.`);
    if (activity.durationMinutes !== undefined && start + activity.durationMinutes > 1440) throw new Error('Activities must finish within the same day.');
    const updated = activity.durationMinutes === undefined ? activity : { ...activity, travelMinutes: transfer };
    previous = updated;
    finish = start + (activity.durationMinutes ?? 0);
    return updated;
  });
}
export function rescheduleActivities<T extends ScheduledActivity>(activities: T[]): T[] {
  const timed = activities.map(a => timeMinutes(a.time)).filter((n): n is number => n !== null);
  let next = Math.min(...timed), previous: T | undefined;
  if (!timed.length) return activities;
  const scheduled = activities.map(activity => {
    if (timeMinutes(activity.time) === null) return activity;
    const transfer = transferMinutes(previous, activity);
    next += transfer;
    const updated = { ...activity, time: clock(next), travelMinutes: transfer };
    next += activity.durationMinutes ?? 30; // Explicit estimate for legacy activities when the order changes.
    const result = activity.durationMinutes === undefined ? { ...updated, durationMinutes: 30 } : updated;
    previous = result;
    return result;
  });
  return validateActivitySchedule(scheduled);
}
