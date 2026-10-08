// Read-only smoke check: public place references and configured AI providers.
// It never opens a database connection or saves a trip.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveAIProviders } from '../src/services/ai/provider.ts';
import { generateGroundedSchedule } from '../src/services/ai/grounded-schedule.ts';
const sample = JSON.parse(readFileSync(new URL('../../audit/2026-10-06/grounded-live-places.json', import.meta.url), 'utf8')).results.find(result => result.anchor.countryCode === 'FR');
if (!sample?.places?.length) throw new Error('Run the public place lookup first.');
const results = await Promise.all(resolveAIProviders().map(async candidate => {
  try {
    const schedule = await generateGroundedSchedule(candidate.provider, sample.anchor, sample.places, '2040-01-25', 1, 2, 'Origin: Toronto, Canada. Budget: EUR 1000 whole group. Prefer culture, a relaxed pace and no invented prices.', AbortSignal.timeout(60000));
    return { provider: candidate.name, status: 'validated', schedule };
  } catch (error) { return { provider: candidate.name, status: 'unavailable', message: error instanceof Error ? error.message : 'Provider failed.' }; }
}));
writeFileSync(new URL('../../audit/2026-10-06/grounded-ai-smoke.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results));
