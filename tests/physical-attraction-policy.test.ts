import assert from 'node:assert/strict';
import test from 'node:test';
import { physicalAttractionDescription } from '../src/services/itinerary/grounded-places.ts';
test('source-backed physical venues exclude virtual markets and administrative areas globally', () => {
  assert.equal(physicalAttractionDescription('online marketplace', ['online marketplace', 'company']), '');
  assert.equal(physicalAttractionDescription('capital and largest city of Japan', ['city', 'tourist destination']), '');
  assert.equal(physicalAttractionDescription('historic city with gardens and museums', ['city', 'tourist destination']), '');
  assert.equal(physicalAttractionDescription('e-commerce company', ['website']), '');
  assert.equal(physicalAttractionDescription('software for museum collections', ['software']), '');
  assert.equal(physicalAttractionDescription('historic painting in a museum', ['painting']), '');
  for (const description of ['park in Japan', 'market in Indonesia', 'museum in France', 'historic building in Kenya', 'gardens in Australia']) assert.equal(physicalAttractionDescription(description, []), description);
  assert.equal(physicalAttractionDescription('public cultural venue', ['art museum']), 'art museum');
  assert.equal(physicalAttractionDescription('public green space', ['city park']), 'city park');
  assert.equal(physicalAttractionDescription('public cultural venue', ['state museum']), 'state museum');
  assert.equal(physicalAttractionDescription('museum in a historic district', ['museum', 'nonprofit organization']), 'museum in a historic district');
});
