import test from 'node:test';
import assert from 'node:assert/strict';
import { administrativeLocationId, administrativeRecord, administrativeCandidate, administrativeChildren, administrativeLabelMatches, philippineAdministrativeRecords, resolveAdministrativeLocation, searchPhilippineCatalogue, validateAdministrativeSelection } from '../src/services/destination/philippine-catalogue.ts';
import { searchGlobalLocations } from '../src/services/destination/global-location-search.ts';
import { searchDestinationAreas, selectedAreaParent, validatedAreaCities } from '../src/services/destination/destination-areas.ts';
import { needsAccommodationArea, resolveDestination } from '../src/services/destination/location-resolution.ts';
import { validateDestinationAnchor } from '../src/services/itinerary/grounded-places.ts';
import { GET as searchStays } from '../src/controllers/accommodations-controller.ts';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';

const cebu = administrativeCandidate(administrativeRecord(administrativeLocationId('0702200000'))!);
const cases = [
  ['Moalboal','0702233000',9.91667,123.43333,'Municipality'],
  ['Badian','0702207000',9.85,123.43333,'Municipality'],
  ['Oslob','0702235000',9.51667,123.4,'Municipality'],
  ['Bantayan','0702209000',11.2,123.73333,'Municipality'],
  ['Naga','0702234000',10.25,123.71667,'City'],
] as const;
const noProvider: typeof fetch = async () => { throw Error('Official catalogue browsing must not require an external provider or hotel inventory.'); };

test('official snapshot contains all 82 provinces, 149 cities and 1,493 municipalities with unique stable PSGC IDs', () => {
  for (const [level,count] of [['Region',18],['Province',82],['City',149],['Municipality',1493]] as const) assert.equal(philippineAdministrativeRecords.filter(r=>r.level===level).length,count);
  assert.equal(new Set(philippineAdministrativeRecords.map(r=>r.code)).size,1742);
  const countryPlaces=administrativeChildren({id:0,name:'Philippines',countryCode:'PH',placeType:'Country'})!;
  assert.equal(countryPlaces.length,1742); assert.equal(countryPlaces.filter(p=>p.placeType==='Region').length,18);
  assert.ok(countryPlaces.some(p=>p.providerId==='0702220000'));
  assert.equal(cebu.placeType,'Province'); assert.equal(cebu.providerId,'0702200000');
});

test('Cebu pagination enumerates 44 municipalities and 6 component cities; independent cities and Bohol never leak through regional matching', async () => {
  const rows = [];
  for (const offset of [0,20,40]) { const page = await searchDestinationAreas(cebu,'',offset,noProvider); rows.push(...page.areas); assert.equal(page.total,50); assert.equal(page.coverage,'complete-administrative'); assert.equal(page.nextOffset,offset===40?null:offset+20); }
  assert.equal(new Set(rows.map(r=>r.id)).size,50);
  assert.equal(rows.filter(r=>r.placeType==='Municipality').length,44);
  assert.equal(rows.filter(r=>r.placeType==='City').length,6);
  assert.ok(rows.every(r=>r.provinceCode==='0702200000' && r.membership==='official-administrative'));
  assert.ok(!rows.some(r=>/Cebu City|Mandaue|Lapu-Lapu|Tagbilaran/.test(r.name)));
});

for (const [query,code,latitude,longitude,level] of cases) test(`${query} searches the entire Cebu dataset and forwards its official identity and geocoded point to generation validation`, async () => {
  const page = await searchDestinationAreas(selectedAreaParent(cebu.id,'PH'),query,0,noProvider);
  const place = page.areas.find(r=>r.administrativeCode===code)!;
  assert.ok(place); assert.equal(place.provinceCode,'0702200000'); assert.equal(place.placeType,level);
  assert.equal(place.latitude,latitude); assert.equal(place.longitude,longitude); assert.match(place.coordinateSource!,/^https:\/\/www.geonames.org\/\d+$/);
  assert.match(place.contextLabel,new RegExp(`Cebu, Philippines — ${level}`));
  const anchor = { id:place.id,provider:place.provider,providerId:place.providerId,administrativeCode:place.administrativeCode,provinceCode:place.provinceCode,geographicProvinceCode:place.geographicProvinceCode,administrativeLevel:place.administrativeLevel,coordinateSource:place.coordinateSource,city:place.name,country:place.country,countryCode:place.countryCode,latitude,longitude };
  const accepted = await validateDestinationAnchor(place.label,anchor,latitude,longitude,noProvider);
  assert.equal(accepted.id,administrativeLocationId(code)); assert.equal(accepted.administrativeCode,code);
  assert.equal((await validateAdministrativeSelection(anchor,noProvider)).id,accepted.id);
});

test('Cebu province is separate from Cebu City, and Naga is qualified by province and country', async () => {
  const results = await searchGlobalLocations('Cebu',noProvider);
  assert.ok(results.some(r=>r.placeType==='Province' && r.providerId==='0702200000'));
  const city = results.find(r=>r.providerId==='0730600000')!; assert.ok(city); assert.equal(city.placeType,'City');
  assert.equal(needsAccommodationArea(cebu),true); assert.equal(needsAccommodationArea(city),false);
  assert.equal((await resolveDestination('Cebu province, Philippines',noProvider)).location?.id,cebu.id);
  const naga = searchPhilippineCatalogue('Naga, Cebu, Philippines');
  assert.equal(naga.length,1); assert.equal(naga[0].administrativeCode,'0702234000');
  const bicol = searchPhilippineCatalogue('Naga, Camarines Sur, Philippines');
  assert.ok(bicol.length); assert.notEqual(bicol[0].id,naga[0].id); assert.ok(bicol[0].latitude!>13);
  assert.equal(searchPhilippineCatalogue('Naga, Cebu, Japan').length,0);
  assert.equal(searchPhilippineCatalogue('City of Naga, Cebu')[0].id,naga[0].id);
  assert.equal(administrativeLabelMatches(naga[0].id,'Naga City, Cebu, Philippines'),true);
  assert.equal(administrativeLabelMatches(naga[0].id,'Naga, Camarines Sur, Philippines'),false);
});

test('wrong province, country, coordinates or substituted PSGC ID cannot reach providers', async () => {
  const p=searchPhilippineCatalogue('Moalboal, Cebu')[0]; const input={id:p.id,countryCode:p.countryCode,providerId:p.providerId,administrativeCode:p.administrativeCode,provinceCode:p.provinceCode,latitude:p.latitude!,longitude:p.longitude!};
  for (const change of [{provinceCode:'0701200000'},{countryCode:'JP'},{longitude:120},{id:administrativeLocationId('0702207000')}]) await assert.rejects(validateAdministrativeSelection({...input,...change},noProvider));
  await assert.rejects(validatedAreaCities(cebu,[searchPhilippineCatalogue('Naga, Camarines Sur')[0].id],noProvider),/within/);
});

test('a municipality named like a country still validates within its Philippine province', async () => {
  const place=searchPhilippineCatalogue('Jordan, Guimaras, Philippines')[0]; assert.ok(place);
  const anchor={id:place.id,provider:place.provider,providerId:place.providerId,administrativeCode:place.administrativeCode,provinceCode:place.provinceCode,city:place.name,country:place.country,countryCode:place.countryCode,latitude:place.latitude!,longitude:place.longitude!};
  assert.equal((await validateDestinationAnchor(place.label,anchor,anchor.latitude,anchor.longitude,noProvider)).id,place.id);
});

test('aliases survive current renames and entries without coordinates remain in the full administrative list', async t => {
  assert.ok(searchPhilippineCatalogue('San Isidro, Davao del Norte').some(r=>r.administrativeCode==='1102324000'));
  assert.ok(searchPhilippineCatalogue('Sanchez-Mira, Cagayan').some(r=>r.administrativeCode==='0201522000'));
  const record=philippineAdministrativeRecords.find(r=>r.code==='1999905000')!; const pending=administrativeCandidate(record);
  assert.equal(pending.coordinateStatus,'unresolved'); assert.ok(administrativeChildren({id:0,name:'Philippines',countryCode:'PH',placeType:'Country'},'Pahamuddin')?.some(r=>r.id===pending.id));
  const previous=process.env.DESTINATION_GEOCODER_URL; process.env.DESTINATION_GEOCODER_URL='https://geocoder.fixture.test/search';
  t.after(()=>{if(previous===undefined)delete process.env.DESTINATION_GEOCODER_URL;else process.env.DESTINATION_GEOCODER_URL=previous;});
  const raw={name:'Pahamuddin',osm_type:'relation',osm_id:123,addresstype:'municipality',lat:'7.2',lon:'124.4',address:{country_code:'ph',region:'Bangsamoro Autonomous Region In Muslim Mindanao'}};
  await assert.rejects(resolveAdministrativeLocation(pending.id,'PH',async()=>Response.json([{...raw,address:{country_code:'id'}}])),/uniquely/);
  await assert.rejects(resolveAdministrativeLocation(pending.id,'PH',async()=>Response.json([raw,{...raw,osm_id:124}])),/uniquely/);
  let calls=0; const provider:typeof fetch=async()=>{calls++;return Response.json([raw]);};
  const [a,b]=await Promise.all([resolveAdministrativeLocation(pending.id,'PH',provider),resolveAdministrativeLocation(pending.id,'PH',provider)]);
  assert.equal(calls,1); assert.equal(a.id,pending.id); assert.deepEqual(a,b); assert.equal(a.providerId,record.code);
});

test('all five selected identities reach the real accommodation controller; zero hotels does not invalidate the municipality', async t => {
  const replace=(object:object,key:string,value:unknown)=>{const prior=Reflect.get(object,key);Reflect.set(object,key,value);t.after(()=>Reflect.set(object,key,prior));};
  replace(prisma.user,'findFirst',async()=>({id:'psgc-test',role:'traveler',accountStatus:'active',emailVerified:true,profileStatus:'unverified',trustScore:50}));
  replace(prisma,'$queryRaw',async()=>[{count:1}]);
  const keys=['ACCOMMODATION_PLACES_URL','ACCOMMODATION_PLACES_FALLBACK_URL','AMADEUS_API_KEY','AMADEUS_API_SECRET','LITEAPI_API_KEY','RAPIDAPI_KEY'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]])); keys.forEach(k=>delete process.env[k]); process.env.ACCOMMODATION_PLACES_URL='https://map.psgc.test/interpreter';
  t.after(()=>{keys.forEach(k=>{if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];});clearProviderCache();});
  const queries:string[]=[];t.mock.method(globalThis,'fetch',async(_input,init)=>{queries.push(decodeURIComponent(String(init?.body)));return Response.json({elements:[]});});
  const headers={cookie:`travelmate_session=${createSessionToken('psgc-test','traveler')}`};
  for (const [query] of cases) {
    const p=searchPhilippineCatalogue(`${query}, Cebu`)[0]; clearProviderCache();
    const params=new URLSearchParams({destination:p.label,countryCode:'PH',locationId:String(p.id),locationProvider:'psgc',locationProviderId:p.providerId!,administrativeCode:p.administrativeCode!,provinceCode:p.provinceCode!,placeType:p.placeType,latitude:String(p.latitude),longitude:String(p.longitude),checkInDate:'2040-01-01',checkOutDate:'2040-01-03',currency:'PHP',adults:'1'});
    const before=queries.length;const response=await searchStays(new Request(`http://localhost/api/accommodations?${params}`,{headers}));const body=await response.json();
    assert.equal(response.status,200); assert.equal(body.status,'no-results'); assert.deepEqual(body.nearbyAccommodations,[]);
    assert.ok(queries.slice(before).some(q=>q.includes(`${p.latitude},${p.longitude}`)));
    params.set('provinceCode','0701200000');assert.equal((await searchStays(new Request(`http://localhost/api/accommodations?${params}`,{headers}))).status,400);
  }
});
