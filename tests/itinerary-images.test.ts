import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPlaceImages, imageResultMatches, type ItineraryResponse } from '../src/controllers/itinerary-controller.ts';

function itinerary(): ItineraryResponse {
  return {
    destination: 'Tokyo, Japan',
    totalBudget: 10_000,
    currency: 'JPY',
    days: [{
      day: 1,
      date: '2026-10-01',
      theme: 'Indoor culture in Shinjuku',
      imageUrl: '/travel-illustration.png',
      totalCost: 1_000,
      activities: [
        { time: '10:00 AM', title: 'Shinjuku Gyoen National Garden Greenhouse', description: 'Explore the greenhouse.', estimatedCost: 500, category: 'activity', icon: 'map', imageUrl: '/travel-illustration.png' },
        { time: '01:00 PM', title: 'Lunch at Omoide Yokocho', description: 'Eat lunch.', estimatedCost: 500, category: 'food', icon: 'food', imageUrl: '/travel-illustration.png' },
      ],
    }],
    budgetSummary: { accommodation: 0, food: 2_000, activities: 2_000, transport: 1_000, reserve: 5_000, dailyAverage: 10_000, total: 10_000 },
  };
}

test('activity images are searched by activity title and destination instead of copied from the day', async () => {
  const queries: string[] = [];
  const result = await attachPlaceImages(itinerary(), async (query, limit) => {
    queries.push(query);
    assert.equal(limit, 5);
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return [{
      imageUrl: `https://upload.wikimedia.org/wikipedia/commons/${slug}.jpg`,
      attribution: { creator: 'Commons contributor', license: 'CC BY-SA 4.0', sourceUrl: `https://commons.wikimedia.org/wiki/${slug}` },
    }];
  });

  assert.deepEqual(queries, [
    'Shinjuku Gyoen National Garden Greenhouse Tokyo, Japan',
    'Lunch at Omoide Yokocho Tokyo, Japan',
  ]);
  assert.match(result.days[0].imageUrl, /shinjuku-gyoen-national-garden-greenhouse/);
  assert.match(result.days[0].activities[0].imageUrl || '', /shinjuku-gyoen-national-garden-greenhouse/);
  assert.match(result.days[0].activities[1].imageUrl || '', /lunch-at-omoide-yokocho/);
  assert.notEqual(result.days[0].activities[0].imageUrl, result.days[0].activities[1].imageUrl);
  assert.equal(result.days[0].activities[0].imageAttribution?.creator, 'Commons contributor');
});

test('image lookup failure preserves safe local activity fallbacks', async () => {
  const result = await attachPlaceImages(itinerary(), async () => []);
  assert.equal(result.days[0].imageUrl, '/travel-illustration.png');
  assert.equal(result.days[0].activities[0].imageUrl, '/travel-illustration.png');
  assert.equal(result.days[0].activities[1].imageUrl, '/travel-illustration.png');
});

test('an unmatched activity never inherits another activity photo attribution', async () => {
  const result = await attachPlaceImages(itinerary(), async (query) => query.startsWith('Shinjuku') ? [{
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/shinjuku-greenhouse.jpg',
    attribution: { creator: 'Garden photographer', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/example' },
  }] : []);
  assert.match(result.days[0].imageUrl, /shinjuku-greenhouse/);
  assert.equal(result.days[0].activities[1].imageUrl, '/travel-illustration.png');
  assert.equal(result.days[0].activities[1].imageAttribution, undefined);
});

test('image relevance matching rejects unrelated generic travel photos', () => {
  assert.equal(imageResultMatches('Tokyo Disneyland Chiba Japan', 'File:Tokyo Disneyland Cinderella Castle.jpg'), true);
  assert.equal(imageResultMatches('Tokyo Disneyland Chiba Japan', 'File:Tropical beach in Boracay Philippines.jpg'), false);
  assert.equal(imageResultMatches('Shinjuku Gyoen National Garden Tokyo Japan', 'File:Shinjuku Gyoen greenhouse Tokyo.jpg'), true);
});

test('retries each missing activity with its place name and geographic context', async () => {
  const queries: string[] = [];
  const result = await attachPlaceImages(itinerary(), async (query) => {
    queries.push(query);
    return query === 'Omoide Yokocho Japan' ? [{
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/omoide.jpg',
      attribution: { creator: 'Photographer', license: 'CC BY-SA', sourceUrl: 'https://commons.wikimedia.org/wiki/File:omoide.jpg' },
    }] : [];
  });
  assert.ok(queries.includes('Omoide Yokocho Tokyo, Japan'));
  assert.ok(queries.includes('Omoide Yokocho Japan'));
  assert.match(result.days[0].activities[1].imageUrl || '', /omoide.jpg/);
  assert.equal(result.days[0].activities[0].imageAttribution, undefined);
});

test('a failed image provider does not fail the itinerary', async () => {
  const result = await attachPlaceImages(itinerary(), async () => { throw new Error('Provider unavailable'); });
  assert.equal(result.days[0].activities.length, 2);
  assert.equal(result.days[0].activities[0].imageAttribution, undefined);
});
