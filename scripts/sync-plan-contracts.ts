import { readFileSync, writeFileSync } from 'node:fs';
import { API_ERROR_CODES } from '../src/contracts/api-error.ts';
const path = new URL('../openapi/travelmate-api.json', import.meta.url);
const document = JSON.parse(readFileSync(path, 'utf8'));
document.components.schemas.ApiError.properties.code.enum = [...API_ERROR_CODES];
for (const [path, summary] of Object.entries({ '/api/plan': 'Read authenticated monthly plan usage', '/api/plan/operations/{key}': 'Recover your own persistent generation operation' })) {
  document.paths[path] = { get: { summary, security: document.paths['/api/itinerary'].post.security,
    ...(path.includes('{key}') ? { parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 } }] } : {}),
    responses: { '200': { description: 'Private, uncached plan usage or operation result' }, '401': { description: 'Authentication required' }, '404': { description: 'No operation owned by this user' } } } };
}
const post = document.paths['/api/itinerary'].post;
post.parameters = [...(post.parameters ?? []).filter((value: { name: string }) => value.name !== 'Idempotency-Key'), { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 8, maxLength: 100 }, description: 'Persistent per-user operation key; reuse only for identical trip details.' }];
post.responses['429'] = { description: 'Monthly AI allowance exhausted (MONTHLY_AI_LIMIT with usage/reset details) or request rate limit (RATE_LIMITED)' };
writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
