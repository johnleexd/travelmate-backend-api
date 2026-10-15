import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedCities, searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { belongsToArea, clearDestinationAreaCaches, searchDestinationAreas, selectedAreaParent } from '../src/services/destination/destination-areas.ts';
import { pointInGeography, parsePolygon } from '../src/services/destination/geographic-membership.ts';
import { clearAreaComparisonCache, compareDestinationAreas } from '../src/services/destination/area-comparison.ts';
import { createAreaCache } from '../src/services/destination/area-cache.ts';
import { GET_AREAS, GET_AREA_COMPARISON } from '../src/controllers/locations-controller.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { rememberResolvedLocation } from '../src/services/destination/resolved-location-cache.ts';

const parent = (query: string) => searchDestinationIndex(query).find(place => ['Country','Region','Island'].includes(place.placeType))!;
const island = parent('Honshū Island, Japan');
const boundary = {name:'Honshu',addresstype:'island',osm_type:'relation',osm_id:6677259,address:{country_code:'jp'},namedetails:{'name:en':'Honshu'},geojson:{type:'Polygon',coordinates:[[[134,33],[142,33],[142,41],[134,41],[134,33]],[[139,40],[141,40],[141,40.8],[139,40.8],[139,40]]]}};

test('countries populate automatically from worldwide geographic records; pages are distinct and country validated', async () => {
  clearDestinationAreaCaches();
  const scope = {parent:parent('Japan'),method:'country-code' as const,sourceUrls:[]};
  assert.equal(belongsToArea({...indexedCities('JP')[0],latitude:120},scope),false);
  assert.equal(belongsToArea({...indexedCities('JP')[0],longitude:200},scope),false);
  for (const query of ['Japan','France','Philippines','Brazil','South Africa']) {
    const selected = parent(query); const first = await searchDestinationAreas(selected,'',0,async () => { throw Error('Country browsing must not call providers.'); });
    assert.equal(first.status,'ready'); assert.ok(first.areas.length > 0); assert.ok(first.areas.every(city => city.countryCode === selected.countryCode && city.membership === (selected.countryCode === 'PH' ? 'official-administrative' : 'country-code') && city.description.length > 0));
    if (first.nextOffset !== null) {
      const more = await searchDestinationAreas(selected,'',first.nextOffset); assert.ok(more.areas.length > 0); assert.ok(more.areas.every(city => !first.areas.some(prior => prior.id === city.id)));
    }
  }
});
test('region browsing validates administrative membership across multiple countries', async () => {
  clearDestinationAreaCaches();
  for (const query of ['Scotland, United Kingdom','Central Visayas, Philippines','Île-de-France, France']) {
    const selected = parent(query); assert.equal(selected.placeType,'Region');
    const result = await searchDestinationAreas(selected); assert.ok(result.areas.length > 0);
    assert.ok(result.areas.every(city => city.countryCode === selected.countryCode && (selected.countryCode === 'PH' ? city.membership === 'official-administrative' : city.region === selected.region && city.membership === 'administrative-hierarchy')));
  }
});
test('islands use polygon membership, not a bounding box; duplicates share one boundary request', async t => {
  clearDestinationAreaCaches(); t.after(clearDestinationAreaCaches); let calls = 0;
  const provider = async (input: any) => { calls++; const url = new URL(String(input)); assert.equal(url.searchParams.get('polygon_geojson'),'1'); assert.equal(url.searchParams.get('countrycodes'),'jp'); return Response.json([boundary]); };
  const [first, second] = await Promise.all([searchDestinationAreas(island,'',0,provider),searchDestinationAreas(island,'',0,provider)]);
  assert.deepEqual(first,second); assert.equal(calls,1); assert.ok(first.areas.some(city => city.name === 'Tokyo'));
  assert.ok(first.areas.every(city => city.membership === 'boundary' && pointInGeography(city.latitude,city.longitude,boundary.geojson as any)));
  assert.ok(!first.areas.some(city => city.name === 'Sapporo' || city.name === 'Aomori'));
});
test('city search extends beyond the catalogue and rejects wrong countries, outside islands and non-settlements', async () => {
  clearDestinationAreaCaches();
  const provider = async (input: any) => {
    if (String(input).includes('nominatim')) return Response.json([boundary]);
    const common = {name:'New Fixture Town',feature_code:'PPL',country:'Japan',country_code:'JP',admin1:'Tokyo',latitude:35.6,longitude:139.7,population:5000};
    return Response.json({results:[{...common,id:999910001},{...common,id:999910002,country_code:'KR'},{...common,id:999910003,latitude:43},{...common,id:999910004,feature_code:'ISL'}]});
  };
  const result = await searchDestinationAreas(island,'New Fixture Town',0,provider);
  assert.equal(result.areas.length,1); assert.equal(result.areas[0].id,999910001); assert.equal(result.areas[0].provider,'geonames');
});
test('missing/ambiguous/wrong-country boundaries return honest empty coverage and never all national cities', async () => {
  for (const rows of [[],[{...boundary,address:{country_code:'kr'}}],[boundary,{...boundary,osm_id:123}], [{...boundary,geojson:{type:'Point',coordinates:[138,36]}}]]) {
    clearDestinationAreaCaches(); const result = await searchDestinationAreas(island,'',0,async () => Response.json(rows));
    assert.equal(result.status,'empty'); assert.deepEqual(result.areas,[]); assert.equal(result.total,0); assert.equal(result.nextOffset,null); assert.match(result.message,/boundary.*cannot be verified/); assert.match(result.message,/Destination field/);
  }
});
test('actual boundary provider failures remain retryable errors', async () => {
  clearDestinationAreaCaches();
  await assert.rejects(searchDestinationAreas(island,'',0,async () => Response.json({}, {status:503})),/provider unavailable/);
  clearDestinationAreaCaches();
  await assert.rejects(searchDestinationAreas(island,'',0,async () => Response.json({unexpected:true})),/invalid data/);
  clearDestinationAreaCaches();
});
test('a region outside the catalogue discovers mapped towns within its verified boundary', async () => {
  clearDestinationAreaCaches();
  const selected = {...island,id:-9988001,name:'Fixture Region',label:'Fixture Region, Japan',placeType:'Region',latitude:30,longitude:130,provider:'openstreetmap' as const,providerId:'relation:9988001'};
  rememberResolvedLocation(selected);
  const provider = async (input: any) => String(input).includes('nominatim')
    ? Response.json([{...boundary,name:'Fixture Region',namedetails:{'name:en':'Fixture Region'},addresstype:'state',osm_id:9988001,geojson:{type:'Polygon',coordinates:[[[129.99,29.99],[130.01,29.99],[130.01,30.01],[129.99,30.01],[129.99,29.99]]]}}])
    : Response.json({elements:[{id:9988111,lat:30,lon:130,tags:{place:'town',name:'Mapped Fixture Town'}},{id:9988222,lat:31,lon:131,tags:{place:'town',name:'Outside Town'}}]});
  const result = await searchDestinationAreas(selectedAreaParent(selected.id,'JP'),'',0,provider);
  assert.equal(result.areas.length,1); assert.equal(result.areas[0].name,'Mapped Fixture Town'); assert.equal(result.areas[0].membership,'boundary'); assert.equal(result.areas[0].providerId,'node:9988111');
});

test('mapped towns recover from a primary timeout using the existing fallback with strict membership checks', async t => {
  clearDestinationAreaCaches(); t.after(clearDestinationAreaCaches);
  const previous = process.env.ACCOMMODATION_PLACES_FALLBACK_URL;
  process.env.ACCOMMODATION_PLACES_FALLBACK_URL = 'https://fallback.example.test/interpreter';
  t.after(() => { if (previous === undefined) delete process.env.ACCOMMODATION_PLACES_FALLBACK_URL; else process.env.ACCOMMODATION_PLACES_FALLBACK_URL = previous; });
  const selected = {...island,id:-9988002,name:'Unindexed Region',label:'Unindexed Region, Japan',placeType:'Region',latitude:30,longitude:130,provider:'openstreetmap' as const,providerId:'relation:9988002'};
  const geometry = {type:'Polygon',coordinates:[[[129.99,29.99],[130.01,29.99],[130.01,30.01],[129.99,30.01],[129.99,29.99]]]};
  const calls:string[] = [];
  const provider:typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.includes('nominatim')) return Response.json([{...boundary,name:selected.name,namedetails:{'name:en':selected.name},addresstype:'state',osm_id:9988002,geojson:geometry}]);
    assert.equal((init?.headers as Record<string,string>)['Content-Type'],'application/x-www-form-urlencoded');
    const query = (init?.body as URLSearchParams).get('data')!;
    assert.match(query, /\[timeout:8\]/);
    assert.match(query, /area\["ISO3166-1"="JP"\]\[admin_level=2\]->\.country;node\(area\.country\)/);
    assert.match(query, /29.99,129.99,30.01,130.01/);
    assert.ok(init?.signal);
    if (!url.includes('fallback.example.test')) return Response.json({}, {status:504});
    return Response.json({elements:[
      {id:9988331,lat:30,lon:130,tags:{place:'town',name:'Verified Town'}},
      {id:9988331,lat:30,lon:130,tags:{place:'town',name:'Verified Town'}},
      {id:9988332,lat:31,lon:131,tags:{place:'town',name:'Outside Town'}},
      {id:9988333,lat:30,lon:130,tags:{place:'town',name:'Wrong Country','addr:country':'KR'}},
      {id:9988334,lat:30,lon:130,tags:{place:'island',name:'Not a town'}},
    ]});
  };
  const result = await searchDestinationAreas(selected,'',0,provider);
  assert.equal(result.status,'ready'); assert.equal(result.areas.length,1); assert.equal(result.areas[0].name,'Verified Town');
  assert.equal(result.areas[0].membership,'boundary'); assert.equal(calls.length,3);
  await searchDestinationAreas(selected,'',0,provider); assert.equal(calls.length,3);
});

test('failed mapped providers stay an error, while a successful empty response remains honest empty coverage', async t => {
  clearDestinationAreaCaches(); t.after(clearDestinationAreaCaches);
  const selected = {...island,id:-9988003,name:'Limited Region',label:'Limited Region, Japan',placeType:'Region',latitude:30,longitude:130,provider:'openstreetmap' as const,providerId:'relation:9988003'};
  const geometry = {type:'Polygon',coordinates:[[[129.99,29.99],[130.01,29.99],[130.01,30.01],[129.99,30.01],[129.99,29.99]]]};
  const provider = (result: Response):typeof fetch => async input => String(input).includes('nominatim') ? Response.json([{...boundary,name:selected.name,namedetails:{'name:en':selected.name},addresstype:'state',osm_id:9988003,geojson:geometry}]) : result.clone();
  await assert.rejects(searchDestinationAreas(selected,'',0,provider(Response.json({}, {status:504}))), /Mapped town suggestions.*Destination field/);
  clearDestinationAreaCaches();
  await assert.rejects(searchDestinationAreas(selected,'',0,provider(Response.json({elements:[],remark:'runtime error: query timed out'}))), /could not complete the search/);
  clearDestinationAreaCaches();
  let mappedCalls = 0;
  const limited = provider(Response.json({}, {status:429}));
  await assert.rejects(searchDestinationAreas(selected,'',0,async (input,init)=>{if (!String(input).includes('nominatim')) mappedCalls++; return limited(input,init);}), /request limit/);
  assert.equal(mappedCalls,1);
  clearDestinationAreaCaches();
  await assert.rejects(searchDestinationAreas(selected,'',0,async (input,init)=>{
    if (String(input).includes('nominatim')) return provider(Response.json({}))(input,init);
    throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  }), /Mapped town suggestions.*Destination field/);
  clearDestinationAreaCaches();
  const result = await searchDestinationAreas(selected,'',0,provider(Response.json({elements:[]})));
  assert.equal(result.status,'empty'); assert.equal(result.total,0); assert.deepEqual(result.areas,[]);
});
test('polygon validation handles holes, dateline islands and malformed provider geometry', () => {
  const hole = parsePolygon({type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[2,2],[4,2],[4,4],[2,4],[2,2]]]})!;
  assert.equal(pointInGeography(1,1,hole),true); assert.equal(pointInGeography(3,3,hole),false); assert.equal(pointInGeography(11,1,hole),false);
  const dateline = parsePolygon({type:'Polygon',coordinates:[[[179,-10],[-179,-10],[-179,10],[179,10],[179,-10]]]})!;
  assert.equal(pointInGeography(0,179.5,dateline),true); assert.equal(pointInGeography(0,-179.5,dateline),true); assert.equal(pointInGeography(0,0,dateline),false);
  assert.equal(parsePolygon({type:'Polygon',coordinates:[[[0,0],[1,1],[2,2]]]}),null);
});
test('mapped comparison uses verified cities, distances and tags, without invented prices or outside-area choices', async () => {
  clearAreaComparisonCache(); const selected = parent('France'); const city = indexedCities('FR')[0]; let calls = 0;
  const provider = async () => { calls++; return Response.json({elements:[{type:'node',id:1,lat:city.latitude,lon:city.longitude,tags:{amenity:'cafe'}},{type:'node',id:1,lat:city.latitude,lon:city.longitude,tags:{amenity:'cafe'}},{type:'way',id:2,center:{lat:city.latitude,lon:city.longitude},tags:{tourism:'museum'}},{type:'node',id:3,lat:city.latitude,lon:city.longitude,tags:{leisure:'park'}},{type:'node',id:4,lat:0,lon:0,tags:{amenity:'restaurant'}},{type:'node',id:5,lat:city.latitude,lon:city.longitude,tags:{amenity:'restaurant','addr:country':'JP'}}]}); };
  const comparison = await compareDestinationAreas(selected,[city.id],provider);
  assert.deepEqual(comparison.profiles,[{cityId:city.id,foodPlaces:1,culturePlaces:1,naturePlaces:1}]); assert.match(comparison.disclaimer,/Prices and affordability are not confirmed/); assert.ok(!('price' in comparison));
  await compareDestinationAreas(selected,[city.id],provider); assert.equal(calls,1);
  await assert.rejects(compareDestinationAreas(selected,[indexedCities('JP')[0].id],provider),/verified cities/); clearAreaComparisonCache();
});
test('geographic cache deduplicates in flight, caches errors and expires results', async t => {
  let now = 1000; t.mock.method(Date,'now',()=>now); let calls = 0;
  const cache = createAreaCache<number>(2,100); const loader = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('a',loader),cache.get('a',loader)]),[1,1]);
  assert.equal(await cache.get('a',loader),1); now += 101; assert.equal(await cache.get('a',loader),2);
  const failure = async () => { calls++; throw Error('provider down'); };
  await assert.rejects(cache.get('b',failure)); await assert.rejects(cache.get('b',failure)); assert.equal(calls,3);
});
test('area API validates parent identity, preserves authentication and rate limiting, and supports immediate suggestions', async t => {
  const replace = (object: object,key: string,value: unknown) => { const prior = Reflect.get(object,key); Reflect.set(object,key,value); t.after(()=>Reflect.set(object,key,prior)); };
  let user: any = null, count = 1;
  replace(prisma.user,'findFirst',async () => user); replace(prisma,'$queryRaw',async () => [{count}]); t.mock.method(Math,'random',()=>0.5);
  const selected = parent('France'); const headers = {cookie:`travelmate_session=${createSessionToken('area-http','traveler')}`};
  const request = (extra = '') => new Request(`http://localhost/api/locations/areas?parentId=${selected.id}&countryCode=FR${extra}`,{headers});
  assert.equal((await GET_AREAS(request())).status,401);
  user = {id:'area-http',role:'traveler',accountStatus:'active',emailVerified:true};
  const response = await GET_AREAS(request()); assert.equal(response.status,200); assert.ok((await response.json()).areas.length > 0);
  assert.equal((await GET_AREAS(request('&offset=-1'))).status,400);
  clearDestinationAreaCaches();
  const unsupportedIsland = parent('Kono-som');
  t.mock.method(globalThis,'fetch',async () => Response.json([]));
  const empty = await GET_AREAS(new Request(`http://localhost/api/locations/areas?parentId=${unsupportedIsland.id}&countryCode=${unsupportedIsland.countryCode}`,{headers}));
  assert.equal(empty.status,200); assert.equal((await empty.json()).status,'empty');
  assert.throws(()=>selectedAreaParent(selected.id,'JP'),/valid parent area/);
  assert.equal((await GET_AREA_COMPARISON(new Request('http://localhost/api/locations/areas/compare?parentId=1&countryCode=FR&cityIds=not-valid',{headers}))).status,400);
  count = 61; const limited = await GET_AREAS(request()); assert.equal(limited.status,429); assert.equal(limited.headers.get('Retry-After'),'60');
});
