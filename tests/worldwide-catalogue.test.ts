import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(),'travelmate-catalogue-'));
process.env.GLOBAL_LOCATION_CATALOGUE_PATH = join(directory,'fixture.sqlite');
const db = new DatabaseSync(process.env.GLOBAL_LOCATION_CATALOGUE_PATH);
db.exec("CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT,feature TEXT,country TEXT,a1 TEXT,a2 TEXT,a3 TEXT,a4 TEXT,latitude REAL,longitude REAL,parent_id INTEGER); CREATE TABLE countries(code TEXT PRIMARY KEY,name TEXT,id INTEGER); CREATE TABLE metadata(key TEXT,value TEXT); CREATE VIRTUAL TABLE names USING fts5(text,content='');");
db.prepare('INSERT INTO countries VALUES(?,?,?)').run('JP','Japan',1861060);
db.prepare('INSERT INTO countries VALUES(?,?,?)').run('US','United States',6252001);
db.prepare('INSERT INTO countries VALUES(?,?,?)').run('PH','Philippines',1694008);
db.prepare('INSERT INTO countries VALUES(?,?,?)').run('CA','Canada',6251999);
db.prepare('INSERT INTO metadata VALUES(?,?)').run('country-aliases',JSON.stringify({JP:['日本','JPN'],US:['USA']}));
const add=(id:number,name:string,feature:string,country:string,a1:string,a2:string,parent:number|null,aliases='')=>{db.prepare('INSERT INTO places VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,name,feature,country,a1,a2,'','',35,139,parent);db.prepare('INSERT INTO names(rowid,text) VALUES(?,?)').run(id,name+' '+aliases);};
add(1861060,'Japan','PCLI','JP','','',null,'日本'); add(6252001,'United States','PCLI','US','','',null,'USA'); add(1694008,'Philippines','PCLI','PH','','',null);
add(1856210,'Nagano-ken','ADM1','JP','26','',1861060,'Nagano 長野県'); add(1853908,'Osaka','ADM1','JP','32','',1861060);
add(1854798,'Obuse','PPL','JP','26','one',1856210,'小布施'); add(999991,'Obuse','PPL','JP','32','one',1853908);
add(100,'Japan','PPL','US','','',6252001,'日本');
add(700000,'Source district','ADMD','JP','','',1861060);add(700001,'Source subdivision','ADMD','JP','','',700000);add(700002,'Tiny recorded hamlet','PPL','JP','','',700001,'Local hamlet alias');
add(700003,'San fixture barangay','ADM4','PH','','',1694008);
add(1717511,'Cebu','ADM2','PH','07','21',1694008);add(1699455,'Moalboal','ADM3','PH','07','21',1717511);add(1717506,'Cebu City','ADM3','PH','07','21',1717511);
add(700004,'San current province fixture','ADM4','PH','07','21',1699455);add(700005,'San independent city fixture','ADM4','PH','07','21',1717506);
add(6251999,'Canada','PCLI','CA','','',null);add(5332921,'California','ADM1','US','CA','',6252001,'CA');add(100001,'Riverside','PPL','US','CA','one',5332921);
for(let i=0;i<45;i++) add(900000+i,'Small village '+String(i).padStart(2,'0'),'PPL','JP','26','one',1856210,'Village alias '+i);
add(760000,'Long parent label for an isolated source fixture used to verify persistence of administrative names beyond the previous one hundred character limit','ADM1','JP','27','',1861060);
add(860000,'Long settlement name from an isolated source fixture used to verify complete storage of location names beyond the previous one hundred character limit','PPL','JP','27','one',760000);
db.exec('UPDATE places SET latitude=35.12345678,longitude=139.98765432 WHERE id=860000;');
db.close();
const { searchCatalogue,searchCatalogueCountries,catalogueLocation,catalogueContains,validateCatalogueSelection }=await import('../src/services/destination/global-catalogue.ts');
const { searchGlobalLocationsPage }=await import('../src/services/destination/global-location-search.ts');
const { searchDestinationAreas,selectedAreaParent,validatedAreaCities }=await import('../src/services/destination/destination-areas.ts');
const { tripNavigationAnchor }=await import('../src/services/navigation/trip-map-service.ts');
const { prisma }=await import('../src/lib/prisma.ts');
const { executePlatformAction }=await import('../src/services/platform/platform-service.ts');
const { buildGroundedPlan,signGroundedPlan }=await import('../src/services/itinerary/grounded-plan.ts');
const { GET }=await import('../src/controllers/locations-controller.ts');
const { createSessionToken }=await import('../src/middlewares/auth-middleware.ts');
test.after(()=>{ /* Windows SQLite keeps its read handle open until this test worker exits; remove only its fixture if possible. */ try { rmSync(join(directory,'fixture.sqlite')); rmSync(directory); } catch {} });
test('optional country browsing searches canonical roots and local aliases without namesake settlements',()=>{
  assert.equal(searchCatalogueCountries().total,4);
  assert.deepEqual(searchCatalogueCountries('Japan').locations.map(p=>p.id),[1861060]);
  assert.deepEqual(searchCatalogueCountries('日本').locations.map(p=>p.id),[1861060]);
  assert.equal(searchCatalogueCountries('',2).locations.length,2);
  assert.equal(searchCatalogue('',0,1861060,undefined,undefined,true)?.locations[0].sourceFeatureCode,'ADM1');
});
test('optional Philippine province browsing includes recorded independent-city associations and retains their official parent',async()=>{
  const province=selectedAreaParent(1000702200000,'PH');
  const page=await searchDestinationAreas(province,'Cebu City',0,fetch,true);
  const city=page.areas.find(p=>p.id===1000730600000)!;
  assert.ok(city);assert.equal(city.membership,'geographic-association');
  assert.equal(city.provinceCode,undefined);assert.equal(city.geographicProvinceCode,'0702200000');
  assert.equal(city.parentId,1000700000000);assert.equal(city.scopeType,'locality');
  assert.equal((await validatedAreaCities(province,[city.id],fetch,true))[0].id,city.id);
  const ordinary=await searchDestinationAreas(province,'',0);assert.equal(ordinary.total,50);
  const browsing=await searchDestinationAreas(province,'',0,fetch,true);assert.equal(browsing.total,53);
});
test('searches aliases in the entire available catalogue, not the initial page; duplicate names preserve source parents',()=>{
  assert.equal(searchCatalogue('小布施, 長野県, 日本')?.locations[0].id,1854798);
  assert.equal(searchCatalogue('Obuse, Osaka, Japan')?.locations[0].id,999991);
  assert.equal(searchCatalogue('Obuse, United States')?.total,0);
  assert.equal(searchCatalogue('Village alias 44, Nagano, Japan')?.locations[0].id,900044);
  assert.equal(catalogueContains(1856210,999991),false);
});
test('exact country IDs lead namesakes for primary and local country names; scoped browsing excludes foreign namesakes and the parent itself',async()=>{
  for(const q of ['Japan','日本','JPN']){const p=await searchGlobalLocationsPage(q);assert.equal(p.locations[0].id,1861060);assert.equal(p.countryScope?.countryCode,'JP');assert.ok(p.locations.every(p=>p.countryCode==='JP'));assert.ok(p.locations.some(p=>!p.name.includes('Japan')));assert.equal(new Set(p.locations.map(p=>p.id)).size,p.locations.length);}
  const parent=selectedAreaParent(1861060,'JP'),page=await searchDestinationAreas(parent,'',0);
  assert.ok(page.total>45);assert.ok(page.areas.every(p=>p.countryCode==='JP'&&p.id!==parent.id));
  assert.equal((await searchDestinationAreas(parent,'Japan',0)).total,0);
  assert.equal((await searchDestinationAreas(parent,'Village alias 44',0)).areas[0].id,900044);
  assert.equal((await searchDestinationAreas(selectedAreaParent(1853908,'JP'),'Village alias 44',0)).total,0);
  assert.equal(catalogueContains(parent.id,parent.id),false);
  assert.equal(catalogueContains(700000,700002),true);
  assert.equal((await searchDestinationAreas(selectedAreaParent(700000,'JP'),'Local hamlet alias',0)).areas[0].id,700002);
});

test('country-aware direct search persists verified scope, pages without gaps, and switches only on exact country aliases',async()=>{
  const ids:number[]=[];let offset:number|null=0;
  while(offset!==null){const p=await searchGlobalLocationsPage('Japan',offset);ids.push(...p.locations.map(p=>p.id));assert.ok(p.locations.every(p=>p.countryCode==='JP'));offset=p.nextOffset;}
  assert.equal(new Set(ids).size,ids.length);assert.ok(ids.includes(900044));assert.ok(!ids.includes(100));
  assert.equal((await searchGlobalLocationsPage('Village alias 44',0,fetch,'JP')).locations[0].id,900044);
  assert.equal((await searchGlobalLocationsPage('Village alias 44',0,fetch,'US')).total,0);
  const switched=await searchGlobalLocationsPage('USA',0,fetch,'JP');assert.equal(switched.countryScope?.countryCode,'US');assert.ok(switched.locations.every(p=>p.countryCode==='US'));
  assert.equal((await searchGlobalLocationsPage('Obuse',0,fetch,'JP')).locations.length,2);
  assert.equal((await searchGlobalLocationsPage('Obuse',0,fetch,'US')).locations.length,0);
});

test('destination API validates country filters, supports empty scoped browsing, and retains auth/rate limits',async t=>{
  const replace=(object:object,key:string,value:unknown)=>{const old=Reflect.get(object,key);Reflect.set(object,key,value);t.after(()=>Reflect.set(object,key,old));};
  let user:unknown=null,count=1;
  replace(prisma.user,'findFirst',async()=>user);replace(prisma,'$queryRaw',async()=>[{count}]);t.mock.method(Math,'random',()=>0.5);
  const headers={cookie:`travelmate_session=${createSessionToken('country-http','traveler')}`};
  const request=(query:string)=>new Request(`http://localhost/api/locations?${query}`,{headers});
  assert.equal((await GET(request('q=Japan'))).status,401);
  user={id:'country-http',role:'traveler',accountStatus:'active',emailVerified:true};
  const browse=await GET(request('q=&countryCode=JP'));assert.equal(browse.status,200);assert.ok((await browse.json()).locations.every((p:{countryCode:string})=>p.countryCode==='JP'));
  const switched=await GET(request('q=Japan&countryCode=US'));assert.equal(switched.status,200);assert.equal((await switched.json()).countryScope.countryCode,'JP');
  for(const query of ['q=Japan&countryCode=ZZ','q=Japan&countryCode=jp','q=Japan&offset=-1','q='])assert.equal((await GET(request(query))).status,400);
  count=61;assert.equal((await GET(request('q=Japan'))).status,429);
});
test('scoped administrative aliases are not reinterpreted as a foreign country ISO code',()=>{
  assert.equal(searchCatalogue('CA')!.locations[0].id,6251999);
  assert.equal(searchCatalogue('CA',0,6252001)!.locations[0].id,5332921);
  assert.equal(searchCatalogue('Riverside, CA',0,6252001)!.locations[0].id,100001);
});
test('pagination enumerates all small children and full descendant searches without population thresholds',async()=>{
  const parent=selectedAreaParent(1856210,'JP'), ids:number[]=[];let offset:number|null=0;
  while(offset!==null){const p=await searchDestinationAreas(parent,'',offset);ids.push(...p.areas.map(p=>p.id));offset=p.nextOffset;assert.equal(p.total,46);}
  assert.equal(new Set(ids).size,46); assert.ok(ids.includes(900044));
  assert.equal((await searchGlobalLocationsPage('Small village',40)).locations.length,5);
});
test('Cordova is returned on bare typing and the complete Cebu official parent, independently of geocoders, hotels and photos',async()=>{
  const page=await searchGlobalLocationsPage('Cordova'); assert.equal(page.locations[0].providerId,'0702220000');
  const parent=selectedAreaParent(1000702200000,'PH'), p=await searchDestinationAreas(parent,'Cordova'); assert.equal(p.total,1); assert.equal(p.areas[0].providerId,'0702220000');
});
test('official Philippine name matches do not hide lower-level source records; the combined cursor pages both catalogues',async()=>{
  const parent=selectedAreaParent(1694008,'PH'),ids:number[]=[];let offset:number|null=0;
  while(offset!==null){const p=await searchDestinationAreas(parent,'San',offset);ids.push(...p.areas.map(a=>a.id));offset=p.nextOffset;assert.equal(p.coverage,'imported-catalogue');}
  assert.ok(ids.some(id=>id>1_000_000_000_000));assert.ok(ids.includes(700003));assert.equal(new Set(ids).size,ids.length);
});
test('lower-level suggestions follow current official municipality assignments rather than a legacy geographic province containing independent cities',async()=>{
  const parent=selectedAreaParent(1000702200000,'PH'),p=await searchDestinationAreas(parent,'San');
  assert.ok(p.areas.some(a=>a.id===700004));assert.ok(!p.areas.some(a=>a.id===700005));
  assert.equal((await validatedAreaCities(parent,[700004]))[0].id,700004);
  await assert.rejects(validatedAreaCities(parent,[700005]),/within/);
  const city=selectedAreaParent(1000730600000,'PH');const children=await searchDestinationAreas(city,'San');assert.ok(children.areas.some(a=>a.id===700005));
});
test('source identity rejects wrong coordinates/paths and survives JSON reopening into the map anchor',()=>{
  const p=catalogueLocation(1854798)!;
  assert.throws(()=>validateCatalogueSelection({...p,latitude:1}),/coordinates/);
  assert.throws(()=>validateCatalogueSelection({...p,locationPath:catalogueLocation(999991)!.locationPath}),/parent path/);
  const anchor={city:p.name,country:p.country,countryCode:p.countryCode,latitude:p.latitude,longitude:p.longitude,id:p.id,provider:p.provider,providerId:p.providerId,locationPath:p.locationPath,scopeType:p.scopeType,sourceFeatureCode:p.sourceFeatureCode};
  const saved=JSON.parse(JSON.stringify({id:'isolated',destination:p.label,latitude:p.latitude,longitude:p.longitude,itinerary:{grounding:{destination:anchor}}}));
  assert.deepEqual(tripNavigationAnchor(saved),anchor);
});
test('production save action, version snapshot, serialization and map reopening retain the full selected identity without a hotel or photo',async t=>{
  const p=catalogueLocation(860000)!;assert.ok(p.name.length>100);assert.ok(p.region.length>100);const anchor={city:p.name,country:p.country,countryCode:p.countryCode,latitude:p.latitude,longitude:p.longitude,region:p.region,id:p.id,provider:p.provider,providerId:p.providerId,locationPath:p.locationPath,scopeType:p.scopeType,sourceFeatureCode:p.sourceFeatureCode};
  const plan=buildGroundedPlan({destination:p.label,anchor,startingLocation:'',startDate:'2040-01-01',endDate:'2040-01-01',budget:10000,currency:'JPY',travelers:1,partyType:'solo',rooms:1,places:[],placeDataStatus:'unavailable',schedule:[{day:1,date:'2040-01-01',theme:'Source fixture; no sightseeing resolved',visits:[],planningStatus:'incomplete'}],source:'catalog',transportation:'walking'});
  plan.groundingProof=signGroundedPlan(plan);
  let stored:Record<string,unknown>|undefined,version:Record<string,unknown>|undefined;
  const oldFind=Reflect.get(prisma.trip,'findUnique'),oldTransaction=Reflect.get(prisma,'$transaction');t.after(()=>{Reflect.set(prisma.trip,'findUnique',oldFind);Reflect.set(prisma,'$transaction',oldTransaction);});
  Reflect.set(prisma.trip,'findUnique',async()=>null);
  Reflect.set(prisma,'$transaction',async(callback:(tx:unknown)=>unknown)=>callback({$queryRaw:async()=>[],trip:{create:async({data}:{data:Record<string,unknown>})=>{stored=JSON.parse(JSON.stringify({...data,latitude:Number(Number(data.latitude).toFixed(6)),longitude:Number(Number(data.longitude).toFixed(6)),weather:null,id:'catalogue-save-fixture',createdAt:new Date(),updatedAt:new Date(),status:'active',archivedAt:null}));return {...stored,startDate:new Date(String(stored!.startDate)),endDate:new Date(String(stored!.endDate)),createdAt:new Date(String(stored!.createdAt)),updatedAt:new Date(String(stored!.updatedAt))};}},itineraryVersion:{aggregate:async()=>({_max:{version:0}}),create:async({data}:{data:Record<string,unknown>})=>{version=JSON.parse(JSON.stringify(data));return data;}},auditEvent:{create:async()=>({})}}));
  const saved=await executePlatformAction({id:'fixture-owner',role:'traveler',name:'Isolated fixture',email:'fixture@example.test',emailVerified:true,profileStatus:'unverified',accountStatus:'active',trustScore:50},'save-trip',{destination:p.label,budget:10000,currency:'JPY',travelers:1,partyType:'solo',startDate:'2040-01-01',endDate:'2040-01-01',interests:[],itinerary:plan});
  const reopened=JSON.parse(JSON.stringify(saved));
  assert.equal(reopened.destinationRegion,p.region);assert.deepEqual(reopened.itinerary.grounding.destination,anchor);assert.deepEqual(tripNavigationAnchor(reopened),anchor);assert.ok(version?.itinerary);assert.ok(stored);
});
