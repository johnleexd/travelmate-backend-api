import type { TestContext } from 'node:test';
import { prisma } from '../../src/lib/prisma.ts';

/** Unit-only quota persistence fixture. Real locking/usage use isolated PG tests. */
export function mockPlanTransaction(t: TestContext) {
  const previous = prisma.$transaction;
  Reflect.set(prisma, '$transaction', async (work: (tx: unknown) => unknown) => work({
    $queryRaw: async () => [{ id: 'fixture-owner' }],
    planSubscription: { findUnique: async () => null },
    generationTracking: { findUniqueOrThrow: async () => ({ startedAt: new Date('2026-10-16T00:00:00Z') }) },
    itineraryGeneration: {
      findUnique: (args: unknown) => Reflect.get(prisma.itineraryGeneration, 'findUnique')(args),
      create: (args: unknown) => Reflect.get(prisma.itineraryGeneration, 'create')(args),
      updateMany: (args: { data: { allowanceState: string } }) => args.data.allowanceState === 'reconciled' ? Promise.resolve({ count: 0 }) : Reflect.get(prisma.itineraryGeneration, 'updateMany')(args),
      count: async () => 0, findFirst: async () => null, findMany: async () => [],
    },
  }));
  t.after(() => Reflect.set(prisma, '$transaction', previous));
}
