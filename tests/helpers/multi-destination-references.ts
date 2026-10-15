import { readFileSync } from 'node:fs';
import type { DestinationAnchor } from '../../src/services/itinerary/grounding-schema.ts';

// Public Wikipedia/Wikidata responses captured on 2026-10-11, reduced to relevant fields.
// Test-only records; production retrieval never reads these fixtures.
export const destinationReferences = JSON.parse(readFileSync(new URL('../fixtures/multi-destination-provider-references.json', import.meta.url), 'utf8')) as Array<{ anchor: DestinationAnchor; pages: any[]; entities: Record<string, any> }>;
export function referenceFetcher(reference: typeof destinationReferences[number]): typeof fetch {
  return async input => {
    const url = new URL(String(input));
    if (url.hostname === 'en.wikipedia.org') return Response.json({ query: { pages: Object.fromEntries(reference.pages.map(page => [page.pageid, page])) } });
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: Object.fromEntries((url.searchParams.get('ids') ?? '').split('|').map(id => [id, reference.entities[id] ?? {}])) });
    return Response.json({}, { status: 503 });
  };
}
