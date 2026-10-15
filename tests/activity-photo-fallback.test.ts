import assert from 'node:assert/strict';
import test from 'node:test';
import { activityPhotoSubject, createActivityPhotoResolver, createItineraryActivityPhotoResolver, fillMissingDayPhotos } from '../src/services/itinerary/activity-photo-fallback.ts';
import type { DayPlan } from '../src/controllers/itinerary-controller.ts';

const subject = { name: 'Recorded Temple', city: 'Recorded City', country: 'South Korea', countryCode: 'KR', placeId: 'Q123', latitude: 36, longitude: 128 };
const file = (overrides: object = {}) => ({ pageid: 42, title: 'File:Recorded Temple entrance.jpg', imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Recorded_Temple.jpg', extmetadata: { Artist: { value: '<a>Photographer &amp; collaborator</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, ImageDescription: { value: 'Recorded Temple entrance' } } }], ...overrides });
const article = (overrides: object = {}) => ({ pageid: 7, title: 'Recorded Temple', pageimage: 'Recorded Temple entrance.jpg', coordinates: [{ lat: 36, lon: 128 }], pageprops: { wikibase_item: 'Q123' }, ...overrides });
function provider(opts: { article?: object; files?: object[]; local?: boolean } = {}) {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname === '/w/api.php') assert.equal(url.searchParams.get('maxlag'), '5');
    else assert.equal(url.pathname, '/wiki/Special:EntityData/Q123.json');
    assert.match((init?.headers as Record<string, string>)['User-Agent'], /TravelMate/);
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: { Q123: { labels: { en: { value: 'Recorded Temple' }, ko: { value: '기록된 사찰' } }, sitelinks: { enwiki: { title: 'Recorded Temple' }, kowiki: { title: '기록된 사찰' } } } } });
    if (url.hostname.endsWith('.wikipedia.org')) return Response.json({ query: { pages: opts.local && url.hostname === 'en.wikipedia.org' ? {} : { 7: opts.article || article(opts.local ? { title: '기록된 사찰' } : {}) } } });
    return Response.json({ query: { pages: Object.fromEntries((opts.files || [file()]).map((row, i) => [i, row])) } });
  };
  return { calls, fetcher };
}

test('Wikipedia exact entity/coordinates and Commons metadata yield the real creator, license and source; lookups coalesce and cache', async () => {
  const p = provider(), resolve = createActivityPhotoResolver(p.fetcher, { intervalMs: 0 });
  const [a, b] = await Promise.all([resolve(subject), resolve(subject)]);
  assert.deepEqual(a, b); assert.equal(a?.imageAttribution.creator, 'Photographer & collaborator');
  assert.equal(a?.imageAttribution.licenseUrl, 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(a?.imageAttribution.sourceUrl, 'https://commons.wikimedia.org/?curid=42');
  assert.equal(p.calls.length, 3); await resolve(subject); assert.equal(p.calls.length, 3);
});

test('Commons category/medium evidence rejects engravings even when the JPEG description looks like a place', async () => {
  const row = file();
  row.imageinfo[0].extmetadata = { ...row.imageinfo[0].extmetadata, Categories: { value: 'Etchings by Israël Silvestre' } } as typeof row.imageinfo[0]['extmetadata'];
  const p = provider({ files: [row] });
  assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject), null);
});
test('local-language sitelinks and names can recover a missing English article', async () => {
  const p = provider({ local: true, files: [file({ title: 'File:기록된 사찰.jpg' })] });
  assert.ok(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject));
  assert.ok(p.calls.some(url => url.hostname === 'ko.wikipedia.org' && url.searchParams.get('titles') === '기록된 사찰'));
});
test('other-provider identities use exact names and coordinates, without comparing their IDs to Wikidata IDs', async () => {
  const p = provider();
  assert.ok(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })({ ...subject, placeId: 'osm:123' }));
  assert.equal(p.calls.some(url => url.hostname === 'www.wikidata.org'), false);
});
test('long thumbnails use the original Commons URL; attribution is never silently truncated', async () => {
  const info = file().imageinfo[0], original = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Original.jpg';
  const p = provider({ files: [file({ imageinfo: [{ ...info, thumburl: original + '?long=' + 'x'.repeat(1000), url: original }] })] });
  assert.equal((await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject))?.imageUrl, original);
  const invalid = provider({ files: [file({ imageinfo: [{ ...info, extmetadata: { ...info.extmetadata, Artist: { value: 'x'.repeat(201) } } }] })] });
  assert.equal(await createActivityPhotoResolver(invalid.fetcher, { intervalMs: 0 })(subject), null);
});
test('same-name distant attractions and different Wikidata entities never qualify via an article', async () => {
  for (const badArticle of [article({ coordinates: [{ lat: 37, lon: 128 }] }), article({ pageprops: { wikibase_item: 'Q999' } }), article({ pageprops: { disambiguation: '' } })]) {
    const p = provider({ article: badArticle, files: [file({ title: 'File:Unrelated city.jpg' })] });
    assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject), null);
  }
});
test('generic city photos, flags, logos, drawings, unknown creators and unsupported licenses remain missing', async () => {
  const base = file();
  const variants = [file({ title: 'File:Recorded City.jpg', imageinfo: [{ ...base.imageinfo[0], extmetadata: { ...base.imageinfo[0].extmetadata, ImageDescription: { value: 'Recorded City, South Korea skyline' } } }] }), file({ title: 'File:Recorded Temple flag.jpg' }), file({ title: 'File:Recorded Temple logo.jpg' }), file({ title: 'File:Recorded Temple drawing.jpg' }), file({ imageinfo: [{ ...base.imageinfo[0], extmetadata: { ...base.imageinfo[0].extmetadata, Artist: { value: '' } } }] }), file({ imageinfo: [{ ...base.imageinfo[0], extmetadata: { ...base.imageinfo[0].extmetadata, LicenseShortName: { value: 'All rights reserved' } } }] }), file({ coordinates: [{ lat: 37, lon: 128 }] }), file({ imageinfo: [{ ...base.imageinfo[0], mime: 'image/svg+xml' }] })];
  for (const invalid of variants) {
    const p = provider({ files: [invalid] });
    assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject), null);
  }
});
test('Commons search requires the complete place name and location evidence, not two common query words', async () => {
  const p = provider({ article: { title: 'Missing article' }, files: [file({ coordinates: [{ lat: 36, lon: 128 }] })] });
  assert.ok(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject));
  const query = p.calls.find(url => url.hostname === 'commons.wikimedia.org' && url.searchParams.has('gsrsearch'))?.searchParams.get('gsrsearch');
  assert.match(query!, /"Recorded Temple" Recorded City South Korea/);
});
test('a place without coordinates requires both city and country evidence', async () => {
  const { latitude: _lat, longitude: _lon, placeId: _id, ...noCoordinates } = subject;
  for (const extract of ['Recorded Temple in Recorded City, South Korea.', 'Recorded Temple in another city.']) {
    const p = provider({ article: article({ coordinates: undefined, pageprops: undefined, extract }), files: [file()] });
    const result = await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(noCoordinates);
    assert.equal(Boolean(result), extract.includes('South Korea'));
  }
});
test('429, maxlag, invalid JSON and timeout fail gracefully; negative/error caches and Retry-After prevent request storms', async () => {
  for (const response of [new Response('', { status: 429, headers: { 'Retry-After': '120' } }), Response.json({ error: { code: 'maxlag' } }), new Response('bad json'), null]) {
    let calls = 0, now = Date.now();
    const fetcher: typeof fetch = async () => { calls++; if (!response) throw new DOMException('Timeout', 'TimeoutError'); return response.clone(); };
    const resolve = createActivityPhotoResolver(fetcher, { intervalMs: 0, now: () => now });
    const failureSubject = { ...subject, placeId: undefined };
    assert.equal(await resolve(failureSubject), null); const initialCalls = calls;
    assert.equal(await resolve(failureSubject), null); assert.equal(calls, initialCalls);
    if (response?.status === 429) { now += 61000; assert.equal(await resolve({ ...failureSubject, name: 'Another Temple' }), null); assert.equal(calls, initialCalls); }
  }
});
test('Wikipedia language links verify numbered local filenames even when optional Wikidata aliases are unavailable', async () => {
  const p = provider({ files: [file({ title: 'File:기록된 사찰1.jpg', imageinfo: [{ ...file().imageinfo[0], extmetadata: { ...file().imageinfo[0].extmetadata, ImageDescription: { value: '' } } }] })] });
  const fetcher: typeof fetch = async (input, init) => {
    const host = new URL(String(input)).hostname;
    if (host === 'www.wikidata.org') return Response.json({ error: { code: 'maxlag' } });
    if (host === 'en.wikipedia.org') return Response.json({ query: { pages: { 7: article({ langlinks: [{ lang: 'ko', '*': '기록된 사찰' }] }) } } });
    return p.fetcher(input, init);
  };
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject));
});
test('concurrent different subjects still serialize provider requests and respect the configured interval', async () => {
  let active = 0, peak = 0; const starts: number[] = [];
  const p = provider();
  const fetcher: typeof fetch = async (input, init) => { starts.push(Date.now()); peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 2)); const response = await p.fetcher(input, init); active--; return response; };
  const resolve = createActivityPhotoResolver(fetcher, { intervalMs: 15 });
  await Promise.all([resolve(subject), resolve({ ...subject, city: 'Another recorded city' })]);
  assert.equal(peak, 1); assert.ok(starts.slice(1).every((start, index) => start - starts[index] >= 14));
});
test('optional Wikidata failure does not block Wikipedia and Commons photo providers', async () => {
  const p = provider();
  const fetcher: typeof fetch = (input, init) => new URL(String(input)).hostname === 'www.wikidata.org' ? Promise.resolve(Response.json({ error: { code: 'maxlag' } })) : p.fetcher(input, init);
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject));
  assert.ok(p.calls.some(url => url.hostname === 'commons.wikimedia.org'));
});
test('missing-day enrichment preserves existing providers/photos and every non-photo field, skips allowances, and does not mutate input', async () => {
  const activity = { title: 'Visit Recorded Temple', time: '10:00', description: 'Recorded description', category: 'activity', icon: 'map', estimatedCost: 123, place: { ...subject, provider: 'wikidata', address: '', openingHours: '', sourceUrl: 'https://www.wikidata.org/wiki/Q123', fetchedAt: new Date().toISOString() } };
  const day = { day: 1, date: '2040-01-01', theme: 'Actual day', imageUrl: '', totalCost: 300, activities: [{ ...activity, category: 'accommodation', imageUrl: 'https://existing-provider.test/preserved.jpg' }, activity, { title: 'Daily meals', time: 'Daily allowance', category: 'food', description: 'Actual allowance', icon: 'food', estimatedCost: 54 }] } as DayPlan;
  const before = structuredClone(day), p = provider(), resolver = createActivityPhotoResolver(p.fetcher, { intervalMs: 0 });
  const result = await fillMissingDayPhotos('Recorded City, South Korea', day, resolver);
  assert.deepEqual(day, before); assert.equal(result.activities[0].imageUrl, before.activities[0].imageUrl); assert.equal(result.activities[2].imageUrl, undefined);
  assert.ok(result.activities[1].imageUrl); assert.ok(result.imageUrl);
  for (let i = 0; i < day.activities.length; i++) { const { imageUrl: _url, imageAttribution: _credit, ...a } = result.activities[i]; const { imageUrl: _old, imageAttribution: _oldCredit, ...b } = day.activities[i]; assert.deepEqual(a, b); }
  assert.equal(activityPhotoSubject(day.activities[2], 'Recorded City, South Korea'), null);
});
test('destination covers verify city/region/country geography without relaxing exact-activity distance checks', async () => {
  const city = { ...subject, name: 'Recorded City', kind: 'destination' as const, region: 'Recorded Province', placeId: undefined };
  const cityArticle = article({ title: 'Recorded City, Recorded Province', coordinates: [{ lat: 36.05, lon: 128 }], extract: 'Recorded City is a city in Recorded Province, South Korea.', pageimage: 'Recorded City skyline.jpg' });
  const p = provider({ article: cityArticle, files: [file({ title: 'File:Recorded City skyline.jpg' })] });
  assert.ok(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(city));
  assert.match(p.calls[0].searchParams.get('titles')!, /Recorded Province/);
  const distant = provider({ article: { ...cityArticle, coordinates: [{ lat: 37, lon: 128 }] }, files: [file({ title: 'File:Recorded City skyline.jpg' })] });
  assert.equal(await createActivityPhotoResolver(distant.fetcher, { intervalMs: 0 })(city), null);
  const precise = provider({ article: article({ coordinates: [{ lat: 36.05, lon: 128 }] }), files: [file()] });
  assert.equal(await createActivityPhotoResolver(precise.fetcher, { intervalMs: 0 })(subject), null);
});
test('a destination sharing a company name searches past its unlocated logo article', async () => {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'commons.wikimedia.org') return Response.json({ query: { pages: { 42: file({ title: 'File:Recorded City skyline.jpg' }) } } });
    return Response.json({ query: { pages: { 7: url.searchParams.get('generator') === 'search'
      ? article({ title: 'Recorded City, Recorded Province', extract: 'Recorded City, South Korea.', pageimage: 'Recorded City skyline.jpg' })
      : article({ title: 'Recorded City', coordinates: undefined, extract: 'Recorded City is a company in South Korea.', pageimage: 'Recorded City logo.svg' }) } } });
  };
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })({ ...subject, name: 'Recorded City', kind: 'destination', region: 'Recorded Province', placeId: undefined }));
  assert.ok(calls.some(url => url.searchParams.get('generator') === 'search'));
  assert.equal(calls.filter(url => url.hostname === 'commons.wikimedia.org').length, 1);
});

test('coordinate-verified entity photos accept evidenced KOGL Type 1, but reject restricted types and wrong campuses', async () => {
  for (const license of ['KOGL Type 1', 'KOGL Type 2', 'KOGL Type 3', 'KOGL Type 4']) {
    const p = provider({ files: [file({ imageinfo: [{ ...file().imageinfo[0], extmetadata: { ...file().imageinfo[0].extmetadata, LicenseShortName: { value: license }, LicenseUrl: { value: 'http://www.kogl.or.kr/info/licenseType1.do' } } }] })] });
    const fetcher: typeof fetch = async (input, init) => new URL(String(input)).hostname === 'www.wikidata.org' ? Response.json({ entities: { Q123: { labels: { en: { value: subject.name } }, claims: { P625: [{ mainsnak: { datavalue: { value: { latitude: 36, longitude: 128, globe: 'http://www.wikidata.org/entity/Q2' } } } }], P18: [{ mainsnak: { datavalue: { value: 'Recorded Temple entrance.jpg' } } }] } } } }) : p.fetcher(input, init);
    const result = await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject);
    assert.equal(Boolean(result), license === 'KOGL Type 1');
    if (result) { assert.equal(result.imageAttribution.licenseUrl, 'https://www.kogl.or.kr/info/licenseType1.do'); assert.equal(p.calls.length, 1); assert.equal(p.calls[0].hostname, 'commons.wikimedia.org'); }
  }
  const p = provider({ files: [file({ coordinates: [{ lat: 37, lon: 128 }] })] });
  assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject), null);
});

test('a verified article without an image still supplies local names for exact Commons search', async () => {
  const p = provider({ files: [file({ coordinates: [{ lat: 36, lon: 128 }] })] });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: {} });
    if (url.hostname.endsWith('.wikipedia.org')) return Response.json({ query: { pages: { 7: article({ pageimage: undefined, langlinks: [{ lang: 'ko', '*': '검증된 사찰' }] }) } } });
    return p.fetcher(input, init);
  };
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject));
  assert.match(p.calls.find(url => url.searchParams.has('gsrsearch'))!.searchParams.get('gsrsearch')!, /검증된 사찰/);
});

test('a known native-language sitelink is checked before nonexistent English articles', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.hostname);
    if (url.hostname === 'www.wikidata.org') return Response.json({ entities: { Q123: { labels: { en: { value: subject.name } }, sitelinks: { kowiki: { title: subject.name } } } } });
    if (url.hostname === 'en.wikipedia.org') throw new Error('An English lookup would waste the paced deadline');
    if (url.hostname === 'ko.wikipedia.org') return Response.json({ query: { pages: { 7: article() } } });
    return Response.json({ query: { pages: { 42: file() } } });
  };
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject));
  assert.deepEqual(calls, ['www.wikidata.org', 'ko.wikipedia.org', 'commons.wikimedia.org']);
});

test('a slow first activity cannot starve a quick verified photo on the same day', async () => {
  const day = { day: 1, activities: ['Slow site', 'Exact site'].map(name => ({ title: name, time: '10:00', place: { ...subject, name } })) } as DayPlan;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40);
  const result = await fillMissingDayPhotos('Recorded City, South Korea', day, async s => {
    if (s.name === 'Slow site') { await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true })); return null; }
    return { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Exact.jpg', imageAttribution: { creator: 'Author', license: 'CC BY 4.0', sourceUrl: 'https://commons.wikimedia.org/?curid=42' } };
  }, controller.signal);
  clearTimeout(timeout);
  assert.equal(result.activities[0].imageUrl, undefined);
  assert.ok(result.activities[1].imageUrl);
  assert.equal(day.activities[1].imageUrl, undefined);
});

test('an alias-provider outage is a short error cache, not an hour-long verified no-photo result', async () => {
  let now = Date.now(), calls = 0;
  const resolve = createActivityPhotoResolver(async input => {
    calls++;
    return new URL(String(input)).hostname === 'www.wikidata.org' ? Response.json({ error: { code: 'maxlag' } }) : Response.json({ query: { pages: {} } });
  }, { intervalMs: 0, now: () => now });
  assert.equal(await resolve(subject), null); const before = calls;
  await resolve(subject); assert.equal(calls, before);
  now += 61000; await resolve(subject); assert.ok(calls > before);
});

test('PageImages requests a free 960px thumbnail and uses it only after file rights verification', async () => {
  const thumbnail = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Recorded_Temple_entrance.jpg/960px-Recorded_Temple_entrance.jpg';
  const p = provider({ article: article({ thumbnail: { source: thumbnail, width: 960, height: 640 } }) });
  const photo = await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject);
  assert.equal(photo?.imageUrl, thumbnail);
  assert.equal(photo?.imageAttribution.creator, 'Photographer & collaborator');
  const query = p.calls.find(url => url.hostname === 'en.wikipedia.org')!.searchParams;
  assert.equal(query.get('piprop'), 'thumbnail|name'); assert.equal(query.get('pithumbsize'), '960'); assert.equal(query.get('pilicense'), 'free');
  const foreign = provider({ article: article({ thumbnail: { source: thumbnail.replaceAll('Recorded_Temple_entrance', 'Unrelated') } }) });
  assert.equal((await createActivityPhotoResolver(foreign.fetcher, { intervalMs: 0 })(subject))?.imageUrl, file().imageinfo[0].thumburl);
});

test('an unrelated direct article with an image does not prevent a geographically verified search match', async () => {
  const p = provider();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'en.wikipedia.org' && !url.searchParams.has('generator')) return Response.json({ query: { pages: { 7: article({ coordinates: [{ lat: 37, lon: 128 }], pageprops: { wikibase_item: 'Q999' } }) } } });
    return p.fetcher(input, init);
  };
  assert.ok(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })(subject));
  assert.ok(p.calls.some(url => url.hostname === 'en.wikipedia.org' && url.searchParams.get('generator') === 'search'));
});

test('two nearby same-name attractions are ambiguous and cannot select the first search hit', async () => {
  let commons = 0;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'commons.wikimedia.org') { commons++; return Response.json({ query: { pages: { 42: file() } } }); }
    return Response.json({ query: { pages: url.searchParams.has('generator') ? {
      7: article({ title: 'Recorded Temple (north)', coordinates: [{ lat: 36.001, lon: 128 }] }),
      8: article({ pageid: 8, title: 'Recorded Temple (south)', coordinates: [{ lat: 36.002, lon: 128 }] }),
    } : {} } });
  };
  assert.equal(await createActivityPhotoResolver(fetcher, { intervalMs: 0 })({ ...subject, placeId: undefined }), null);
  assert.equal(commons, 0);
});

test('unknown, noncommercial, no-derivatives, conflicting and restricted licenses are rejected', async () => {
  for (const change of [
    { LicenseShortName: { value: 'CC BY 99.0' } }, { LicenseShortName: { value: 'CC BY-NC 4.0' } },
    { LicenseShortName: { value: 'CC BY-ND 4.0' } }, { LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0/' } },
    { NonFree: { value: 'true' } }, { Restrictions: { value: 'Do not reuse' } },
  ]) {
    const info = file().imageinfo[0];
    const p = provider({ files: [file({ imageinfo: [{ ...info, extmetadata: { ...info.extmetadata, ...change } }] })] });
    assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject), null);
  }
  const info = file().imageinfo[0];
  const p = provider({ files: [file({ imageinfo: [{ ...info, extmetadata: { ...info.extmetadata, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/deed.en' } } }] })] });
  assert.ok(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })(subject));
});

test('different subject cache keys deduplicate shared entity, article and file metadata requests', async () => {
  const p = provider(), resolve = createActivityPhotoResolver(p.fetcher, { intervalMs: 0 });
  const [a, b] = await Promise.all([resolve({ ...subject, region: 'Region A' }), resolve({ ...subject, region: 'Region B' })]);
  assert.deepEqual(a, b); assert.ok(a); assert.equal(p.calls.length, 3);
});

test('Wikipedia precedes Unsplash; any fallback is marked illustrative and complete failure stays empty', async () => {
  const exact = { imageUrl: file().imageinfo[0].thumburl, imageAttribution: { creator: 'Commons author', license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/?curid=42' } };
  const fallback = { imageUrl: 'https://images.unsplash.com/photo-fallback', imageAttribution: { creator: 'Fallback author', license: 'Unsplash', sourceUrl: 'https://unsplash.com/photos/fallback', provider: 'unsplash' as const, photoId: 'fallback', illustrative: false, match: 'place' as const } };
  let calls = 0;
  const unsplash = async () => { calls++; return fallback; };
  assert.deepEqual(await createItineraryActivityPhotoResolver(async () => exact, unsplash)(subject), exact); assert.equal(calls, 0);
  const illustration = await createItineraryActivityPhotoResolver(async () => null, unsplash)(subject);
  assert.equal(illustration?.imageAttribution.illustrative, true); assert.equal(illustration?.imageAttribution.match, 'activity');
  assert.equal(illustration?.imageAttribution.photoId, 'fallback'); assert.equal(calls, 1);
  assert.equal(await createItineraryActivityPhotoResolver(async () => null, async () => null)(subject), null);
});

test('a supplied Wikidata ID cannot substitute for missing destination evidence', async () => {
  const p = provider({ article: article({ coordinates: undefined, extract: 'An attraction in an unrelated city.' }), files: [file({ title: 'File:Unrelated file.jpg' })] });
  assert.equal(await createActivityPhotoResolver(p.fetcher, { intervalMs: 0 })({ ...subject, latitude: undefined, longitude: undefined }), null);
});

test('maxlag honors Retry-After even when MediaWiki returns HTTP 200', async () => {
  let now = Date.now(), wikiCalls = 0;
  const resolve = createActivityPhotoResolver(async input => {
    if (new URL(String(input)).hostname === 'en.wikipedia.org') { wikiCalls++; return Response.json({ error: { code: 'maxlag' } }, { headers: { 'Retry-After': '120' } }); }
    return Response.json({ query: { pages: {} } });
  }, { intervalMs: 0, now: () => now });
  const onlyEnglish = { ...subject, placeId: undefined, countryCode: undefined };
  await resolve(onlyEnglish); assert.equal(wikiCalls, 1);
  now += 61000; await resolve({ ...onlyEnglish, name: 'Another exact attraction' }); assert.equal(wikiCalls, 1);
  now += 60000; await resolve({ ...onlyEnglish, name: 'Third exact attraction' }); assert.equal(wikiCalls, 2);
});
