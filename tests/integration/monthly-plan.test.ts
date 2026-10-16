import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isolatedPlanDatabase } from '../helpers/isolated-plan-db.ts';
import { allowancePeriod, planConfiguration } from '../../src/services/plans/plan-policy.ts';

test('monthly allowance uses isolated PostgreSQL transactions, HTTP authentication and durable operation recovery', async t => {
  const db = await isolatedPlanDatabase();
  const { client: prisma } = db;
  const service = await import('../../src/services/plans/plan-service.ts');
  const { createSessionToken } = await import('../../src/middlewares/auth-middleware.ts');
  const { default: app } = await import('../../src/app.ts');
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port');
  const base = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  const user = async (role: 'traveler' | 'admin' = 'traveler') => prisma.user.create({ data: { name: 'Isolated plan test', email: `${randomUUID()}@example.test`, role, emailVerified: true } });
  const reserve = async (id: string, key = randomUUID()) => {
    const value = await service.reserveGeneration(id, 'Tokyo', { destination: 'Tokyo' }, key);
    assert.ok('recordId' in value); return value;
  };
  const http = (id: string | null, path: string, body?: unknown, key = randomUUID()) => nativeFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(id ? { cookie: `travelmate_session=${createSessionToken(id, 'traveler')}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('running API persists a validated Gemini result, repairs internally without extra deductions, replays it and keeps provider failures separate', async sub => {
      const owner = await user(), key = randomUUID();
      const { destinationReferences, referenceFetcher } = await import('../helpers/multi-destination-references.ts');
      const reference = destinationReferences[0], anchor = reference.anchor;
      const { clearProviderCache } = await import('../../src/services/cache/provider-cache.ts'); clearProviderCache();
      const keys = ['AI_PROVIDER', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
      const prior = Object.fromEntries(keys.map(name => [name, process.env[name]]));
      process.env.AI_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'isolated-fixture-key'; delete process.env.OPENAI_API_KEY;
      let calls = 0, fail = false;
      sub.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('generativelanguage.googleapis.com')) {
          calls++;
          if (fail) return Response.json({ error: { message: 'Provider quota exhausted' } }, { status: 429 });
          const request = JSON.parse(String(init?.body));
          assert.ok(request.generationConfig.maxOutputTokens <= 32768);
          if (request.contents[0].parts[0].text.startsWith('{')) {
            const prompt = JSON.parse(request.contents[0].parts[0].text);
            return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ scheduled: [], deferred: prompt.remaining.map((item: { id: string }) => item.id) }) }] } }] });
          }
          const text = calls === 1 ? 'malformed JSON for controlled repair' : JSON.stringify({ days: [{ day: 1, date: '2040-01-01', theme: 'Fixture AI plan', visits: [] }, { day: 2, date: '2040-01-02', theme: 'Fixture AI plan', visits: [] }] });
          return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
        }
        return referenceFetcher(reference)(input, init);
      });
      try {
        const body = { destination: `${anchor.city}, ${anchor.country}`, destinationDetails: anchor, latitude: anchor.latitude, longitude: anchor.longitude, startDate: '2040-01-01', endDate: '2040-01-02', budget: 40000, currency: 'EUR', travelers: 2, partyType: 'couple' };
        const response = await http(owner.id, '/api/itinerary', body, key);
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.source, 'gemini'); assert.equal(calls, 2);
        assert.equal((await service.getPlan(owner.id)).used, 1);
        assert.equal((await http(owner.id, '/api/itinerary', body, key)).status, 200); assert.equal(calls, 2);
        const saved = await http(owner.id, '/api/platform', { action: 'save-trip', destination: body.destination, destinationDetails: anchor, budget: 40000, currency: 'EUR', startDate: body.startDate, endDate: body.endDate, travelers: 2, partyType: 'couple', itinerary: result, interests: [], weather: null });
        assert.equal(saved.status, 200); const trip = (await saved.json()).result;
        const edited = structuredClone(result); edited.days[0].activities[0].description = 'Manual note';
        assert.equal((await http(owner.id, '/api/platform', { action: 'update-trip-itinerary', id: trip.id, itinerary: edited })).status, 200);
        assert.equal((await service.getPlan(owner.id)).used, 1);
        fail = true;
        const failed = await http(owner.id, '/api/itinerary', body); assert.equal(failed.status, 200); assert.equal((await failed.json()).source, 'catalog');
        assert.equal((await service.getPlan(owner.id)).used, 1); assert.equal((await service.getPlan(owner.id)).reserved, 0);
        const managed = await (await http(owner.id, `/api/platform/trips/${trip.id}/activities`)).json();
        const input = { revision: managed.revision, dayIndex: 0, fromTime: '09:00', toTime: '18:00', mode: 'walking' };
        const failedPreview = await http(owner.id, `/api/platform/trips/${trip.id}/replan`, input);
        assert.equal(failedPreview.status, 503); assert.notEqual((await failedPreview.json()).code, 'MONTHLY_AI_LIMIT');
        assert.equal((await service.getPlan(owner.id)).reserved, 0); assert.equal((await service.getPlan(owner.id)).used, 1);
        fail = false;
        const replanKey = randomUUID(), previewResponse = await http(owner.id, `/api/platform/trips/${trip.id}/replan`, input, replanKey);
        const preview = await previewResponse.json(); assert.equal(previewResponse.status, 200, JSON.stringify(preview));
        assert.equal((await service.getPlan(owner.id)).used, 2);
        const beforeReplayCalls = calls;
        assert.equal((await http(owner.id, `/api/platform/trips/${trip.id}/replan`, input, replanKey)).status, 200); assert.equal(calls, beforeReplayCalls);
        const operation = await service.readGeneration(owner.id, replanKey); assert.equal(operation.kind, 'day-replan'); assert.equal(operation.tripId, trip.id);
        assert.equal((await http(owner.id, `/api/platform/trips/${trip.id}/replan/accept`, { revision: managed.revision, token: preview.token, confirm: true })).status, 200);
        assert.equal((await service.getPlan(owner.id)).used, 2);
      } finally { for (const name of keys) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } clearProviderCache(); }
    });
    await t.test('calendar-month boundaries and configuration are server controlled', () => {
      assert.equal(planConfiguration({}).free, 3); assert.equal(planConfiguration({}).plus, 30);
      assert.throws(() => planConfiguration({ AI_FREE_MONTHLY_LIMIT: '-1' }));
      assert.deepEqual(allowancePeriod(new Date('2026-10-31T15:59:59Z')), { start: new Date('2026-09-30T16:00:00Z'), end: new Date('2026-10-31T16:00:00Z') });
      assert.deepEqual(allowancePeriod(new Date('2026-10-31T16:00:00Z')), { start: new Date('2026-10-31T16:00:00Z'), end: new Date('2026-11-30T16:00:00Z') });
      assert.equal(allowancePeriod(new Date('2028-02-15Z')).end.toISOString(), '2028-02-29T16:00:00.000Z');
    });
    await t.test('concurrent tabs reserve only one operation and successful persistence deducts once', async () => {
      const owner = await user(), key = randomUUID();
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(owner.id, key)));
      const winners = attempts.filter(result => result.status === 'fulfilled'); assert.equal(winners.length, 1);
      for (const result of attempts) if (result.status === 'rejected') assert.equal(result.reason.code, 'GENERATION_IN_PROGRESS');
      const operation = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reserve>>>).value;
      assert.equal((await service.getPlan(owner.id)).reserved, 1);
      await service.processGeneration(operation.recordId, operation.attemptId);
      const completions = await Promise.all(Array.from({ length: 4 }, () => service.persistGeneration(operation.recordId, operation.attemptId, { destination: 'Tokyo', days: [{ day: 1 }] })));
      assert.equal(completions.filter(Boolean).length, 1);
      const usage = await service.getPlan(owner.id); assert.equal(usage.used, 1); assert.equal(usage.reserved, 0); assert.equal(usage.remaining, 2);
      assert.ok('replay' in await service.reserveGeneration(owner.id, 'Tokyo', { destination: 'Tokyo' }, key));
      await assert.rejects(() => service.reserveGeneration(owner.id, 'Osaka', { destination: 'Osaka' }, key), { code: 'GENERATION_CONFLICT' });
    });
    await t.test('final allowance commit and simultaneous reservation cannot exceed the monthly limit', async () => {
      const owner = await user();
      for (let i = 0; i < 2; i++) {
        const operation = await reserve(owner.id);
        await service.persistGeneration(operation.recordId, operation.attemptId, { result: i });
      }
      const last = await reserve(owner.id);
      const [completion, attempt] = await Promise.allSettled([
        service.persistGeneration(last.recordId, last.attemptId, { result: 'last' }),
        reserve(owner.id),
      ]);
      assert.equal(completion.status, 'fulfilled');
      assert.equal(attempt.status, 'rejected');
      if (attempt.status === 'rejected') assert.ok(['GENERATION_IN_PROGRESS', 'MONTHLY_AI_LIMIT'].includes(attempt.reason.code));
      const usage = await service.getPlan(owner.id);
      assert.equal(usage.used, 3); assert.equal(usage.reserved, 0); assert.equal(usage.remaining, 0);
    });
    await t.test('failure releases reservation; terminal keys never silently restart', async () => {
      const owner = await user(), operation = await reserve(owner.id);
      await service.processGeneration(operation.recordId, operation.attemptId);
      await service.releaseGeneration(operation.recordId, operation.attemptId, 'AI_PROVIDER_UNAVAILABLE');
      assert.equal((await service.getPlan(owner.id)).remaining, 3);
      const row = await prisma.itineraryGeneration.findUniqueOrThrow({ where: { id: operation.recordId } });
      await assert.rejects(() => reserve(owner.id, row.idempotencyKey), { code: 'GENERATION_ENDED' });
      assert.equal(await service.persistGeneration(operation.recordId, operation.attemptId, { late: true }), false);
    });
    await t.test('disconnect/restart retains live reservations; expired work reconciles and old workers are fenced', async () => {
      const owner = await user(), operation = await reserve(owner.id);
      await service.processGeneration(operation.recordId, operation.attemptId);
      const row = await prisma.itineraryGeneration.findUniqueOrThrow({ where: { id: operation.recordId } });
      assert.equal((await service.readGeneration(owner.id, row.idempotencyKey)).status, 'pending');
      assert.equal((await service.getPlan(owner.id)).reserved, 1);
      // Simulate a dead process by expiring its durable lease, without re-calling AI.
      await prisma.itineraryGeneration.update({ where: { id: operation.recordId }, data: { reservedUntil: new Date(Date.now() - 1000) } });
      const usage = await service.getPlan(owner.id); assert.equal(usage.reserved, 0); assert.equal(usage.used, 0);
      assert.equal((await service.readGeneration(owner.id, row.idempotencyKey)).state, 'reconciled');
      assert.equal(await service.persistGeneration(operation.recordId, operation.attemptId, { late: true }), false);
      assert.ok(await reserve(owner.id));
    });
    await t.test('a killed worker and a fresh process recover the same persistent operation without a second provider call', async () => {
      const owner = await user(), key = randomUUID();
      const worker = (mode: string) => new Promise<Record<string, string | number>>((resolve, reject) => {
        const child = spawn(process.execPath, ['--experimental-strip-types', 'tests/helpers/plan-restart-worker.ts', mode, db.schema, owner.id, key], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', received = false;
        const timer = setTimeout(() => { child.kill(); reject(new Error('Restart test worker timed out.')); }, 20000);
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('\n') && !received) {
            received = true; clearTimeout(timer);
            const result = JSON.parse(output.trim());
            if (mode === 'reserve') { child.once('exit', () => resolve(result)); child.kill(); }
            else resolve(result);
          }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); if (!received) reject(new Error(`Restart test worker ended (${code}).`)); });
      });
      const operation = await worker('reserve');
      assert.deepEqual(await worker('read'), { status: 'pending', reserved: 1, used: 0 });
      assert.equal(await service.persistGeneration(String(operation.recordId), String(operation.attemptId), { recovered: true }), true);
      assert.deepEqual(await worker('read'), { status: 'completed', reserved: 0, used: 1 });
    });
    await t.test('old records remain unmetered and month rollover keeps reservations in their original period', async () => {
      const owner = await user();
      await prisma.itineraryGeneration.create({ data: { userId: owner.id, destination: 'Legacy', idempotencyKey: randomUUID(), requestHash: 'legacy', status: 'completed', response: { days: [] } } });
      assert.equal((await service.getPlan(owner.id)).used, 0);
      const operation = await reserve(owner.id);
      const prior = new Date(allowancePeriod().start.getTime() - 86400000);
      await prisma.itineraryGeneration.update({ where: { id: operation.recordId }, data: { allowancePeriod: allowancePeriod(prior).start } });
      await service.persistGeneration(operation.recordId, operation.attemptId, { result: 'previous month' });
      assert.equal((await service.getPlan(owner.id)).used, 0);
      assert.equal((await service.getPlan(owner.id, prior)).used, 1);
    });
    await t.test('quota exhaustion blocks direct full-trip and day-replan requests while saved trips remain accessible', async () => {
      const owner = await user();
      for (let i = 0; i < 3; i++) { const op = await reserve(owner.id); await service.persistGeneration(op.recordId, op.attemptId, { result: i }); }
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserve(owner.id)));
      assert.ok(results.every(value => value.status === 'rejected' && value.reason.code === 'MONTHLY_AI_LIMIT'));
      const planResponse = await http(owner.id, '/api/plan'); assert.equal(planResponse.status, 200); assert.equal((await planResponse.json()).remaining, 0);
      assert.match(planResponse.headers.get('cache-control')!, /no-store/);
      assert.equal((await http(owner.id, '/api/platform?scope=traveler&summary=true')).status, 200);
      assert.equal((await http(null, '/api/plan')).status, 401);
      assert.equal((await http(owner.id, '/api/plan', { plan: 'Plus', allowance: 999 })).status, 404);
      const stranger = await user(); const op = await prisma.itineraryGeneration.findFirstOrThrow({ where: { userId: owner.id } });
      assert.equal((await http(stranger.id, '/api/plan/operations/' + op.idempotencyKey)).status, 404);
      const replanResponse = await http(owner.id, '/api/platform/trips/fake/replan', { revision: 'a'.repeat(64), dayIndex: 0, fromTime: '09:00', toTime: '17:00', mode: 'walking' });
      assert.equal(replanResponse.status, 429); assert.equal((await replanResponse.json()).code, 'MONTHLY_AI_LIMIT');
      const { indexedDestination } = await import('../../src/services/destination/destination-index.ts');
      const tokyo = indexedDestination(1850147, 'JP')!;
      const fullResponse = await http(owner.id, '/api/itinerary', { destination: tokyo.label, destinationDetails: { city: tokyo.name, country: tokyo.country, countryCode: tokyo.countryCode, latitude: tokyo.latitude, longitude: tokyo.longitude }, latitude: tokyo.latitude, longitude: tokyo.longitude, startDate: '2040-01-01', endDate: '2040-01-02', budget: 40000, currency: 'JPY', travelers: 2, partyType: 'couple' });
      assert.equal(fullResponse.status, 429); assert.equal((await fullResponse.json()).code, 'MONTHLY_AI_LIMIT');
    });
    await t.test('admin grants preserve usage, enforce permissions and immutable keys; expiry returns to Free', async () => {
      const owner = await user(), admin = await user('admin'), expiry = new Date(Date.now() + 86400000), key = randomUUID();
      const op = await reserve(owner.id); await service.persistGeneration(op.recordId, op.attemptId, { result: true });
      await assert.rejects(() => service.grantDemoPlus(owner.id, owner.id, key, 'Test', expiry), { code: 'FORBIDDEN' });
      await service.grantDemoPlus(admin.id, owner.id, key, 'Isolated development grant', expiry);
      const plus = await service.getPlan(owner.id); assert.equal(plus.plan, 'Plus'); assert.equal(plus.used, 1); assert.equal(plus.remaining, 29); assert.equal(plus.source, 'admin_demo');
      await service.grantDemoPlus(admin.id, owner.id, key, 'Isolated development grant', expiry);
      assert.equal(await prisma.planActivation.count({ where: { userId: owner.id } }), 1);
      const second = randomUUID(); await service.grantDemoPlus(admin.id, owner.id, second, 'Extension', new Date(expiry.getTime() + 86400000));
      await service.grantDemoPlus(admin.id, owner.id, key, 'Isolated development grant', expiry);
      assert.equal((await service.getPlan(owner.id)).expiresAt, new Date(expiry.getTime() + 86400000).toISOString());
      assert.equal((await service.getPlan(owner.id, new Date(expiry.getTime() + 2 * 86400000))).plan, 'Free');
      await assert.rejects(() => service.grantDemoPlus(admin.id, owner.id, key, 'Altered reason', expiry), { code: 'CONFLICT' });
      await prisma.planSubscription.update({ where: { userId: owner.id }, data: { source: 'verified_payment' } });
      await assert.rejects(() => service.grantDemoPlus(admin.id, owner.id, randomUUID(), 'Cannot replace paid', new Date(expiry.getTime() + 3 * 86400000)), { code: 'CONFLICT' });
    });
    await t.test('configurable operation rate limit applies independently of monthly quota', async () => {
      const owner = await user(); const prior = process.env.AI_GENERATION_REQUEST_LIMIT; process.env.AI_GENERATION_REQUEST_LIMIT = '1';
      try { const op = await reserve(owner.id); await service.releaseGeneration(op.recordId, op.attemptId, 'CONFIRMED_FAILURE'); await assert.rejects(() => reserve(owner.id), { code: 'RATE_LIMITED' }); }
      finally { if (prior === undefined) delete process.env.AI_GENERATION_REQUEST_LIMIT; else process.env.AI_GENERATION_REQUEST_LIMIT = prior; }
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await db.close(); }
});
