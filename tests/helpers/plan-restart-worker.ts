import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { loadBackendEnvironment } from '../../src/config/backend-environment.ts';
loadBackendEnvironment();
const [mode, schema, userId, key] = process.argv.slice(2);
if (!/^travelmate_plan_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Restart checks require an isolated schema.');
const url = new URL(process.env.PLAN_TEST_DATABASE_URL || process.env.DATABASE_URL!);
if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace('-pooler.', '.');
url.searchParams.set('options', `-c search_path=${schema}`);
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });
globalThis.travelmatePrisma = client;
const service = await import('../../src/services/plans/plan-service.ts');
if (mode === 'reserve') {
  const operation = await service.reserveGeneration(userId, 'Restart check', { destination: 'Restart check' }, key);
  if (!('recordId' in operation)) throw new Error('Expected a new isolated operation');
  await service.processGeneration(operation.recordId, operation.attemptId);
  console.log(JSON.stringify(operation));
  // Parent kills this process after the durable reservation, simulating a crash.
  setInterval(() => {}, 1000);
} else {
  const operation = await service.readGeneration(userId, key), usage = await service.getPlan(userId);
  console.log(JSON.stringify({ status: operation.status, reserved: usage.reserved, used: usage.used }));
  await client.$disconnect();
}
