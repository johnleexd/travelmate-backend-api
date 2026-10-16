import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { loadBackendEnvironment } from '../../src/config/backend-environment.ts';

/** Fresh schema only: never migrate/reset the configured application's schema. */
export async function isolatedPlanDatabase() {
  loadBackendEnvironment();
  const connectionString = process.env.PLAN_TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('A PostgreSQL connection is required for the isolated plan check.');
  const schema = `travelmate_plan_test_${randomUUID().replaceAll('-', '')}`;
  const direct = new URL(connectionString);
  // PgBouncer rejects startup search_path; use Neon's paired direct hostname.
  if (direct.hostname.endsWith('.neon.tech')) direct.hostname = direct.hostname.replace('-pooler.', '.');
  const admin = new pg.Client({ connectionString: direct.toString(), connectionTimeoutMillis: 10000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const cleanup = async () => {
    // Only the exact random schema created by this process may be dropped.
    if (!/^travelmate_plan_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid isolated schema.');
    await admin.query('RESET search_path');
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  };
  try {
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of (await readdir(new URL('../../prisma/migrations/', import.meta.url))).filter(value => /^\d/.test(value)).sort()) {
      await admin.query(await readFile(new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url), 'utf8'));
    }
    const url = new URL(direct); url.searchParams.set('options', `-c search_path=${schema}`);
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 12, connectionTimeoutMillis: 10000 }, { schema }) });
    globalThis.travelmatePrisma = client;
    return { client, schema, close: async () => { await client.$disconnect(); await cleanup(); } };
  } catch (error) { await cleanup(); throw error; }
}
