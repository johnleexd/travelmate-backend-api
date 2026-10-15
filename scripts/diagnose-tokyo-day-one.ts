import fs from 'node:fs';
import pg from 'pg';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const directory = '../audit/2026-10-15/tokyo-day-one';
fs.mkdirSync(directory, { recursive: true });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 15000, max: 1 });
const summary = (plan: Record<string, any>) => plan?.days?.map((day: Record<string, any>) => ({
  day: day.day, date: day.date, status: day.planningStatus, reason: day.planningReason,
  activities: day.activities.map((a: Record<string, any>, index: number) => ({ index, title: a.title, category: a.category, time: a.time, duration: a.durationMinutes, placeId: a.place?.placeId, placeName: a.place?.name, photo: !!a.imageUrl })),
}));
try {
  const rows = (await pool.query("SELECT id,destination,start_date::text,end_date::text,budget::text,currency,travelers,interests,itinerary,weather,created_at,updated_at FROM public.trips WHERE destination ILIKE '%Tokyo%' ORDER BY created_at DESC LIMIT 20")).rows;
  const inventory = rows.map(row => ({ id: row.id, destination: row.destination, start: row.start_date, end: row.end_date, budget: row.budget, currency: row.currency, created: row.created_at, days: summary(row.itinerary) }));
  fs.writeFileSync(directory + '/inventory.json', JSON.stringify(inventory, null, 2));
  console.log(JSON.stringify(inventory.map(row => ({ ...row, days: row.days?.map((day: any) => ({ ...day, activities: day.activities.filter((a: any) => a.category === 'activity' || a.placeId) })) })), null, 2));
  const id = process.argv[2];
  if (id) {
    const trip = rows.find(row => row.id === id);
    if (!trip) throw Error('Requested Tokyo trip not found; no writes were performed.');
    const versions = (await pool.query('SELECT version,kind,itinerary,created_at FROM public.itinerary_versions WHERE trip_id=$1 ORDER BY version', [id])).rows;
    const generations = (await pool.query("SELECT id,response,created_at FROM public.itinerary_generations WHERE status='completed' AND user_id=(SELECT user_id FROM public.trips WHERE id=$1) AND destination=$2 ORDER BY created_at DESC LIMIT 20", [id, trip.destination])).rows;
    if (process.argv[3] === '--verify') {
      const before = JSON.parse(fs.readFileSync(directory + '/saved-capture.json', 'utf8'));
      const result = { tripId: id, itineraryUnchanged: JSON.stringify(before.trip.itinerary) === JSON.stringify(trip.itinerary), weatherUnchanged: JSON.stringify(before.trip.weather) === JSON.stringify(trip.weather), updatedAtUnchanged: new Date(before.trip.updated_at).getTime() === trip.updated_at.getTime(), versionsUnchanged: JSON.stringify(before.versions) === JSON.stringify(versions), versionCount: versions.length };
      fs.writeFileSync(directory + '/unchanged-check.json', JSON.stringify(result, null, 2));
      if (Object.entries(result).some(([key, value]) => key.endsWith('Unchanged') && value !== true)) throw Error('Saved data changed during diagnosis; original snapshot retained.');
      console.log(JSON.stringify(result));
    } else fs.writeFileSync(directory + '/saved-capture.json', JSON.stringify({ trip, versions, generations }, null, 2));
    console.log(JSON.stringify({ selectedTrip: id, versions: versions.map(row => ({ version: row.version, kind: row.kind, created: row.created_at, days: summary(row.itinerary.itinerary ?? row.itinerary) })), generations: generations.map(row => ({ id: row.id, created: row.created_at, days: summary(row.response?.itinerary ?? row.response) })) }, null, 2));
  }
} finally { await pool.end(); }
