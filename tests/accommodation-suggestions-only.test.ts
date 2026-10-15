import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { GET } from '../src/controllers/accommodations-controller.ts';
import { RapidHotelProvider } from '../src/services/travel/rapid-hotel-provider.ts';

function replace(t:TestContext,target:object,key:string,value:unknown) { const old=Reflect.get(target,key);Reflect.set(target,key,value);t.after(()=>Reflect.set(target,key,old)); }
function setup(t:TestContext) {
  replace(t,prisma.user,'findFirst',async()=>({id:'suggestions-fixture',role:'traveler',accountStatus:'active',emailVerified:true}));
  replace(t,prisma,'$queryRaw',async()=>[{count:1}]);replace(t,Math,'random',()=>0.5);
  const prior={...process.env};Object.assign(process.env,{LITEAPI_API_KEY:'sand_fixture',LITEAPI_ENV:'sandbox'});
  t.after(()=>{for(const key of ['LITEAPI_API_KEY','LITEAPI_ENV']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}});
  const headers={cookie:`travelmate_session=${createSessionToken('suggestions-fixture','traveler')}`};
  const params=new URLSearchParams({mode:'suggestions',destination:'Tokyo, Japan',countryCode:'JP',placeType:'City',latitude:'35.68',longitude:'139.76',checkInDate:'2040-01-01',checkOutDate:'2040-01-03',currency:'JPY',adults:'20'});
  return (extra:Record<string,string>={})=>{const query=new URLSearchParams(params);for(const [key,value]of Object.entries(extra))query.set(key,value);return new Request(`http://localhost/api/accommodations?${query}`,{headers});};
}
test('property suggestions accept 20 travelers without rooms or nationality and never request test prices',async t=>{
  const request=setup(t),calls:string[]=[];
  replace(t,globalThis,'fetch',async(input:unknown)=>{
    const url=new URL(String(input));calls.push(url.pathname);
    const hotel={id:'lp123',name:'Property content fixture',address:'Tokyo, Japan',country:'JP',latitude:35.68,longitude:139.76,main_photo:'https://static.cupid.travel/property-fixture.jpg',starRating:4,hotelFacilities:['WiFi']};
    if(url.pathname.endsWith('/data/hotels'))return Response.json({data:[hotel]});
    if(url.pathname.endsWith('/data/hotel'))return Response.json({data:hotel});
    throw Error('Rate, availability or booking requests are forbidden in this suggestion test.');
  });
  for(const extras of [{},{occupancy:'not-json',guestNationality:'invalid',quotes:'true'}]){
    const response=await GET(request(extras));assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.providerAccommodations.length,1);const stay=body.providerAccommodations[0];
    assert.equal(stay.name,'Property content fixture');assert.equal(stay.propertyId,'lp123');assert.equal(stay.photos.length,1);assert.equal(stay.rating,4);assert.equal(stay.latitude,35.68);
    assert.equal(stay.quote,undefined);assert.equal(stay.quoteToken,undefined);assert.equal(stay.availability,'price-unavailable');
    assert.match(body.message,/hotel selection is optional/i);assert.doesNotMatch(body.message,/nationality|occupancy|enter.*room/i);
  }
  assert.ok(calls.every(path=>/\/data\/hotels?$/.test(path)));
});
test('failed suggestion searches remain retryable and never impose guest input requirements',async t=>{
  const request=setup(t);replace(t,globalThis,'fetch',async()=>Response.json({error:'fixture unavailable'},{status:503}));
  const response=await GET(request());assert.equal(response.status,200);const body=await response.json();assert.equal(body.status,'provider-error');assert.deepEqual(body.providerAccommodations,[]);assert.doesNotMatch(body.message,/nationality|occupancy/i);
});
test('Rapid suggestions retain property details and permitted photos without availability or occupancy requests',async()=>{
  const calls:string[]=[];
  const provider=new RapidHotelProvider({RAPID_API_KEY:'fixture',RAPID_API_SECRET:'fixture',RAPID_ENV:'production',RAPID_CONTENT_RIGHTS_CONFIRMED:'true',RAPID_PHOTO_ATTRIBUTION_TEXT:'Authorized fixture photographer'},async input=>{
    const url=new URL(String(input));calls.push(url.pathname);
    if(url.pathname==='/v3/regions')return Response.json([{property_ids:['123']}]);
    if(url.pathname==='/v3/properties/content')return Response.json({'123':{property_id:'123',name:'Content-only property fixture',address:{line_1:'Tokyo',country_code:'JP'},location:{coordinates:{latitude:35.68,longitude:139.76}},images:[{caption:'Exterior',links:{'1000px':{href:'https://images.trvl-media.com/fixture.jpg'}}}],amenities:{wifi:{name:'WiFi'}}}});
    throw Error('Suggestion discovery must not shop for rooms.');
  });
  const stays=await provider.search({destination:'Tokyo',countryCode:'JP',latitude:35.68,longitude:139.76,checkInDate:'2040-01-01',checkOutDate:'2040-01-03',currency:'JPY',occupancy:[]},'fixture',{suggestionsOnly:true});
  assert.equal(stays.length,1);assert.equal(stays[0].photos.length,1);assert.deepEqual(stays[0].amenities,['WiFi']);assert.equal(stays[0].quote,undefined);assert.equal(stays[0].quoteToken,undefined);assert.deepEqual(calls,['/v3/regions','/v3/properties/content']);
});
