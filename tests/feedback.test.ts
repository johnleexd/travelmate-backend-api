import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackQuery, submitFeedback, validateFeedback } from '../src/services/platform/feedback-service.ts';
import type { PublicUser } from '../src/schemas/domain.ts';

test('feedback validates input and does not invent sentiment rather than trusting client identity/classification', () => {
  const input = { itineraryId: ' trip ', rating: 4, category: 'budget_accuracy', comment: '  Budget estimates were helpful.  ', userId: 'other', sentiment: 'negative' };
  assert.deepEqual(validateFeedback(input), { itineraryId: 'trip', rating: 4, category: 'budget_accuracy', comment: 'Budget estimates were helpful.', sentiment: 'not_analyzed' });
  for (const value of [null, [], {}, { ...input, itineraryId: '' }, { ...input, category: 'invalid' }, { ...input, comment: 'short' }, { ...input, comment: 'x'.repeat(2001) }, ...[0,6,1.5,'5',null].map(rating => ({ ...input, rating }))]) assert.throws(() => validateFeedback(value));
});

test('feedback filters combine rating, sentiment and inclusive UTC date boundaries', () => {
  const result = feedbackQuery(new URLSearchParams('rating=3&sentiment=neutral&from=2026-10-01&to=2026-10-05&page=2'));
  assert.deepEqual(result, { where: { rating: 3, sentiment: 'neutral', createdAt: { gte: new Date('2026-10-01T00:00:00Z'), lt: new Date('2026-10-06T00:00:00Z') } }, page: 2, pageSize: 10 });
  for (const query of ['rating=6','rating=1.5','sentiment=unknown','from=2026-02-30','from=2026-10-06&to=2026-10-05','page=0','page=1.5','page=-1','page=1000001']) assert.throws(() => feedbackQuery(new URLSearchParams(query)));
});

test('admins cannot submit traveler feedback', async () => {
  await assert.rejects(() => submitFeedback({ role: 'admin' } as PublicUser, {}), /Only travelers/);
});

test('feedback search matches persisted comments, travelers and itineraries with other filters', () => {
  const query = feedbackQuery(new URLSearchParams('q=Tokyo&rating=4'));
  assert.equal(query.where.rating, 4);
  assert.equal(query.where.OR?.length, 4);
  assert.deepEqual(query.where.OR?.[0], { comment: { contains: 'Tokyo', mode: 'insensitive' } });
  assert.throws(() => feedbackQuery(new URLSearchParams({ q: 'x'.repeat(201) })), /at most 200/);
});
