import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveGroundedPlaces } from '../src/services/itinerary/grounded-places.ts';
import { destinationReferences, referenceFetcher } from './helpers/multi-destination-references.ts';

test('a stalled reference host times out once and a healthy language source still supplies verified attractions', async () => {
  const reference = destinationReferences[0]; // Captured Hamburg reference, with German-language fallback.
  assert.equal(reference.anchor.countryCode, 'DE');
  const original = referenceFetcher(reference);
  let stalledRequests = 0;
  const startedAt = Date.now();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'en.wikipedia.org') {
      stalledRequests++;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => reject(new Error('Stalled request was not aborted.')), 3000);
        const abort = () => { clearTimeout(timer); reject(signal?.reason); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (url.hostname === 'de.wikipedia.org') url.hostname = 'en.wikipedia.org';
    return original(url, init);
  };
  const places = await retrieveGroundedPlaces(reference.anchor, fetcher, undefined, false, { requestTimeoutMs: 30 });
  assert.ok(places.length >= 3, 'A timed-out host must not prevent healthy sources from supplying places.');
  assert.equal(stalledRequests, 1, 'Do not spend another timeout on the same unavailable host.');
  assert.ok(Date.now() - startedAt < 1500, 'Lookup should not consume the 90-second catalog deadline.');
});
