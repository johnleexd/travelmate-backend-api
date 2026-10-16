import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { GET_RESOLVE } from '../src/controllers/locations-controller.ts';
import { GET as GET_STAYS } from '../src/controllers/accommodations-controller.ts';
import { resolveDestination, normalizeResolvedPlaces, destinationAreas } from '../src/services/destination/location-resolution.ts';
import { searchGlobalLocations } from '../src/services/destination/global-location-search.ts';
import { parseDestinationQuery } from '../src/services/destination/destination-query.ts';
import { searchDestinationIndex } from '../src/services/destination/destination-index.ts';
import { resolveDestinationContext } from '../src/services/destination/destination-context-service.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';

const geocoded = {place_id:880001,osm_type:'relation',osm_id:10337872,lat:'10.2521909',lon:'123.9494748',name:'Cordova',addresstype:'town',address:{town:'Cordova',state:'Cebu',region:'Central Visayas',country:'Philippines',country_code:'ph'},boundingbox:['10.1491519','10.2799577','123.8896035','124.0199951']};
test('compound region/country names are parsed and filtered without mixing same-name towns', async () => {
  assert.deepEqual(parseDestinationQuery('Cordova, Cebu Philippines'),{term:'Cordova',qualifiers:['Cebu'],countryCode:'PH'});
  assert.deepEqual(parseDestinationQuery('Cordova, Cebu, Philippines'),{term:'Cordova',qualifiers:['Cebu'],countryCode:'PH'});
  assert.deepEqual(parseDestinationQuery('San Jose, Costa Rica'),{term:'San Jose',qualifiers:[],countryCode:'CR'});
  const fake = async (input: any) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get('name'),'Cordova'); assert.equal(url.searchParams.get('countryCode'),'PH');
    return Response.json({results:[{id:1,name:'Cordova',feature_code:'PPL',country_code:'PH',country:'Philippines',admin1:'Western Visayas',admin2:'Iloilo',latitude:10.73,longitude:122.4}]});
  };
  const result=await searchGlobalLocations('Cordova, Cebu Philippines',fake);
  assert.equal(result.length,1); assert.equal(result[0].providerId,'0702220000'); assert.equal(result[0].provinceCode,'0702200000');
});
test('manual resolution reuses official Philippine identity and its crosswalk geocode; subsequent suggestions share that identity', async () => {
  const urls: string[]=[];
  const result = await resolveDestination('Cordova, Cebu Philippines',async input => {
    urls.push(String(input)); return String(input).includes('geocoding-api') ? Response.json({results:[]}) : Response.json([geocoded]);
  });
  assert.equal(result.location?.countryCode,'PH'); assert.equal(result.location?.providerId,'0702220000');
  assert.ok(Number.isFinite(result.location?.latitude)); assert.equal(resolveDestinationContext(result.location!.countryCode,result.location!.name).currency,'PHP');
  assert.equal(urls.length,0, 'Existing verified geocodes need no new provider request.');
  const suggestions = await searchGlobalLocations('Cordova, Cebu Philippines',async () => {throw Error('Must use resolved cache.');});
  assert.equal(suggestions[0].providerId,result.location?.providerId);
});
test('geocoder identity filtering rejects wrong-country/region, road and malformed results', () => {
  const rows = normalizeResolvedPlaces([geocoded,{...geocoded,place_id:2,address:{...geocoded.address,state:'Iloilo'}},{...geocoded,place_id:3,address:{...geocoded.address,country_code:'es'}},{...geocoded,place_id:4,addresstype:'road'},{...geocoded,place_id:5,lat:'not a coordinate'}],'Cordova, Cebu, Philippines');
  assert.equal(rows.length,1); assert.ok(rows[0].bounds);
});
test('explicit geocoder types distinguish province, city, town and unconfirmed settlements', () => {
  for (const [addresstype,expected] of [['province','Province'],['city','City'],['town','Town'],['municipality','Municipality'],['village','Settlement (type unconfirmed)']]) {
    assert.equal(normalizeResolvedPlaces([{...geocoded,addresstype}],'Cordova, Cebu, Philippines')[0]?.placeType,expected);
  }
});
test('ambiguous manual names require selection instead of blindly choosing the first result', async () => {
  const result = await resolveDestination('Unlisted Twin, France',async () => Response.json({results:[1,2].map(id=>({id:999900000+id,name:'Unlisted Twin',feature_code:'PPL',country:'France',country_code:'FR',admin1:`Different region ${id}`,latitude:45+id,longitude:2,population:200000}))}));
  assert.equal(result.location,null); assert.ok(result.candidates.length>1); assert.match(result.message,/Several/);
});
test('countries and regions offer genuine narrowing cities, including supported euro currencies', async () => {
  const country = (await resolveDestination('Japan')).location!;
  assert.equal(country.placeType,'Country'); assert.ok(destinationAreas(country).length>0);
  assert.ok(destinationAreas(country).every(place=>place.countryCode==='JP' && place.placeType!=='Country'));
  const region = searchDestinationIndex('Central Visayas')[0];
  assert.ok(destinationAreas(region).some(place=>place.name==='Cebu City'));
  assert.equal(resolveDestinationContext('MT','Valletta').currency,'EUR');
  assert.equal(resolveDestinationContext('CR','San Jose').currency,'CRC');
});
test('authenticated manual and suggestion coordinates use identical map queries; expansion and errors stay distinct', async t => {
  const replace = (object: object,key: string,value: unknown) => { const prior = Reflect.get(object,key); Reflect.set(object,key,value); t.after(()=>Reflect.set(object,key,prior)); };
  replace(prisma.user,'findFirst',async () => ({id:'manual-http',name:'Test',email:'test@example.test',role:'traveler',accountStatus:'active',emailVerified:true,profileStatus:'unverified',trustScore:50}));
  replace(prisma,'$queryRaw',async () => [{count:1}]); t.mock.method(Math,'random',()=>0.5);
  const prior = {...process.env};
  process.env.ACCOMMODATION_PLACES_URL='https://map.manual.test/interpreter'; delete process.env.ACCOMMODATION_PLACES_FALLBACK_URL; delete process.env.AMADEUS_API_KEY; delete process.env.AMADEUS_API_SECRET; delete process.env.LITEAPI_API_KEY;
  t.after(()=>{for(const key of ['ACCOMMODATION_PLACES_URL','ACCOMMODATION_PLACES_FALLBACK_URL','AMADEUS_API_KEY','AMADEUS_API_SECRET','LITEAPI_API_KEY']) {if(prior[key]===undefined) delete process.env[key]; else process.env[key]=prior[key];} clearProviderCache();});
  const headers = {cookie:`travelmate_session=${createSessionToken('manual-http','traveler')}`};
  const resolvedResponse = await GET_RESOLVE(new Request('http://localhost/api/locations/resolve?q=Cordova%2C%20Cebu%20Philippines',{headers}));
  const location = (await resolvedResponse.json()).location; assert.equal(resolvedResponse.status,200);
  let mode: 'ready'|'nearby'|'empty'|'failure'='ready'; const queries:string[]=[];
  t.mock.method(globalThis,'fetch',async (_input,init) => {
    const query = decodeURIComponent(String(init?.body)); queries.push(query);
    if(mode==='failure') return Response.json({}, {status:503});
    if(mode==='empty' || mode==='nearby'&&!query.includes('around:30000')) return Response.json({elements:[]});
    return Response.json({elements:[{type:'node',id:1,lat:mode==='nearby'?location.latitude+0.15:location.latitude,lon:location.longitude,tags:{name:'Mapped property fixture',tourism:'hotel','addr:city':mode==='nearby'?'Actual nearby town':'Cordova','addr:country':'PH'}}]});
  });
  const params = new URLSearchParams({destination:location.label,countryCode:'PH',placeType:location.placeType,latitude:String(location.latitude),longitude:String(location.longitude),checkInDate:'2040-01-01',checkOutDate:'2040-01-05',adults:'2',currency:'PHP'});
  const stays = async () => (await GET_STAYS(new Request(`http://localhost/api/accommodations?${params}`,{headers}))).json();
  clearProviderCache(); const manual=await stays(); clearProviderCache(); const suggestion=await stays();
  assert.deepEqual(manual.nearbyAccommodations,suggestion.nearbyAccommodations); assert.equal(queries[0],queries[1]); assert.equal(manual.status,'ready'); assert.equal(manual.quoteStatus,'not-configured');
  assert.match(manual.message,/room-quote provider is not configured/); assert.equal(manual.nearbyAccommodations[0].city,'Cordova'); assert.ok(!('price' in manual.nearbyAccommodations[0]));
  clearProviderCache(); mode='nearby'; const nearby=await stays(); assert.equal(nearby.status,'ready'); assert.equal(nearby.nearbyAccommodations[0].city,'Actual nearby town'); assert.match(nearby.message,/expanding to 30 km/);
  clearProviderCache(); mode='empty'; assert.equal((await stays()).status,'no-results');
  clearProviderCache(); mode='failure'; assert.equal((await stays()).status,'provider-error');
});
test('location resolution errors never return a falsely confirmed location', async () => {
  await assert.rejects(resolveDestination('Unmapped Hamlet, France',async ()=>Response.json({}, {status:503})),/unavailable/);
});
