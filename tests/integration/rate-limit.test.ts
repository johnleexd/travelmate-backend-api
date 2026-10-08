import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';
import { allowRequest } from '../../src/middlewares/rate-limit-middleware.ts';

test('migrated rate-limit buckets support authentication limits and expired windows', async t => {
  const key = `integration:rate-limit:${randomUUID()}`;
  t.after(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { key } });
    await prisma.$disconnect();
  });

  assert.equal(await allowRequest(key, 2, 60_000), true);
  assert.equal(await allowRequest(key, 2, 60_000), true);
  assert.equal(await allowRequest(key, 2, 60_000), false);
  const bucket = await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } });
  assert.equal(bucket.count, 3);
  assert.ok(bucket.resetAt.getTime() > Date.now());

  await prisma.rateLimitBucket.update({ where: { key }, data: { resetAt: new Date(0) } });
  assert.equal(await allowRequest(key, 2, 60_000), true);
  assert.equal((await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } })).count, 1);
});
