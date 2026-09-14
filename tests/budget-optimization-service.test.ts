import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBudgetOptimization } from '../src/services/budget/budget-optimization-service.ts';

const input = (plannedSpend: number) => ({
  budget: 10_000,
  reserve: 1_000,
  plannedSpend,
  travelers: 2,
  accommodation: { nightlyRate: 2_000, nights: 2 },
  days: [{
    day: 1,
    activities: [
      { title: 'Island tour', estimatedCost: 3_000, category: 'activity' },
      { title: 'Dinner', estimatedCost: 1_000, category: 'food' },
      { title: 'Taxi', estimatedCost: 500, category: 'transport' },
    ],
  }],
});

test('over-budget plans receive explicit alternatives with savings and tradeoffs', () => {
  const result = buildBudgetOptimization(input(12_000));
  assert.equal(result.status, 'over_budget');
  assert.equal(result.amountToTarget, 2_000);
  assert.ok(result.suggestions.length >= 3);
  assert.ok(result.suggestions.every((suggestion) => suggestion.estimatedSavings > 0 && suggestion.tradeoff.length > 0));
  assert.equal(result.suggestions.find((suggestion) => suggestion.category === 'activity')?.affectedActivityTitle, 'Island tour');
  assert.equal(result.projectedSpendIfAllApplied, 12_000 - result.combinedEstimatedSavings);
  assert.match(result.disclaimer, /Nothing is changed automatically/);
});

test('plans inside budget but using the safety reserve are near the limit', () => {
  const result = buildBudgetOptimization(input(9_500));
  assert.equal(result.status, 'near_limit');
  assert.equal(result.targetSpend, 9_000);
  assert.equal(result.amountToTarget, 500);
});

test('plans preserving the target reserve do not receive unnecessary changes', () => {
  const result = buildBudgetOptimization(input(8_500));
  assert.equal(result.status, 'within_budget');
  assert.equal(result.amountToTarget, 0);
  assert.deepEqual(result.suggestions, []);
});
