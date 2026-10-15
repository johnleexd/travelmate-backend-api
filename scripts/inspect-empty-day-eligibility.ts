import fs from 'node:fs';
import pg from 'pg';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on', max: 1 });
try {
  const rows = (await pool.query('SELECT id,destination,itinerary FROM public.trips WHERE status=\'active\'')).rows;
  const report = rows.map(row => ({ id: row.id, destination: row.destination, grounding: !!row.itinerary.grounding, manuallyEdited: row.itinerary.manuallyEdited, days: row.itinerary.days.filter((day: any) => !day.activities.some((a: any) => a.place)).map((day: any) => ({ day: day.day, status: day.planningStatus, theme: day.theme, activities: day.activities.map((a: any) => ({ title: a.title, time: a.time, category: a.category, location: a.location })) })) }));
  fs.writeFileSync('../audit/2026-10-13/missing-activities/repair-eligibility.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.filter(row => row.days.length), null, 2));
} finally { await pool.end(); }
