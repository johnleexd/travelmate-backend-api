import assert from 'node:assert/strict';
import { mockPlanTransaction } from './helpers/plan-transaction.ts';
import {after,test,type TestContext} from 'node:test';
import {prisma} from '../src/lib/prisma.ts';
import {createSessionToken} from '../src/middlewares/auth-middleware.ts';
import {GET as search} from '../src/controllers/accommodations-controller.ts';
import {POST as check} from '../src/controllers/accommodation-check-controller.ts';
import {POST as generate} from '../src/controllers/itinerary-controller.ts';
import {searchDestinationIndex} from '../src/services/destination/destination-index.ts';
import {parseSavedItinerary} from '../src/services/itinerary/saved-trip-schema.ts';
import {verifyGroundedPlan} from '../src/services/itinerary/grounded-plan.ts';
after(()=>prisma.$disconnect());
function replace(t:TestContext,object:object,key:string,value:unknown){const prior=Reflect.get(object,key);Reflect.set(object,key,value);t.after(()=>Reflect.set(object,key,prior));}
test('authenticated search → rate refresh → generation → save validation keeps exact LiteAPI selection',async t=>{
 mockPlanTransaction(t);
 const user={id:'lite-http',name:'Test',email:'guest@example.test',role:'traveler',accountStatus:'active',emailVerified:true,profileStatus:'unverified',trustScore:50};
 replace(t,prisma.user,'findFirst',async()=>user);replace(t,prisma,'$queryRaw',async()=>[{count:1}]);replace(t,prisma.listing,'findMany',async()=>[]);
 replace(t,prisma.itineraryGeneration,'findUnique',async()=>null);replace(t,prisma.itineraryGeneration,'create',async()=>({id:'generation',attemptId:'attempt'}));replace(t,prisma.itineraryGeneration,'updateMany',async()=>({count:1}));replace(t,Math,'random',()=>0.5);
 const prior={...process.env};const settings={AI_PROVIDER:'openai',OPENAI_API_KEY:'fixture-only',AI_MOCK_FALLBACK:'false',LITEAPI_API_KEY:'sand_fixture',LITEAPI_ENV:'sandbox',ACCOMMODATION_QUOTE_SECRET:'fixture-only-encryption-secret-more-than-32-characters'};
 Object.assign(process.env,settings);delete process.env.GEMINI_API_KEY;
 t.after(()=>{for(const key of [...Object.keys(settings),'GEMINI_API_KEY']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}});
 const place=searchDestinationIndex('Tokyo, Japan').find(p=>p.name==='Tokyo')!;
 let changed=false;const calls:any[]=[];
 replace(t,globalThis,'fetch',async(url:unknown,init?:RequestInit)=>{
  if(String(url).startsWith('https://api.liteapi.travel/')){
   const parsed=new URL(String(url)),body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path:parsed.pathname,body});
   const hotel={id:'lp123',name:'Official Tokyo Hotel fixture',address:'1 Central Street, Tokyo',country:'JP',latitude:place.latitude,longitude:place.longitude,main_photo:'https://static.cupid.travel/hotels/exact.jpg'};
   if(parsed.pathname.endsWith('/data/currencies'))return Response.json({data:[{code:'JPY'}]});
   if(parsed.pathname.endsWith('/data/hotels'))return Response.json({data:[hotel]});
   if(parsed.pathname.endsWith('/data/hotel'))return Response.json({data:hotel});
   assert.equal(parsed.pathname,'/v3.0/hotels/rates');assert.deepEqual(body.occupancies,[{adults:2,children:[5]}]);assert.equal(body.guestNationality,'PH');
   const total=changed?13000:12345;
   return Response.json({sandbox:true,data:[{hotelId:'lp123',roomTypes:[{offerId:'fixture-offer',offerRetailRate:{amount:total,currency:'JPY'},rates:[{mappedRoomId:100,name:'Family room',boardType:'RO',adultCount:2,childCount:1,childrenAges:[5],retailRate:{total:[{amount:total,currency:'JPY'}],taxesAndFees:[{included:false,description:'Facility fee',amount:300,currency:'JPY'}]},cancellationPolicies:{refundableTag:'RFN'}}]}]}]});
  }
  if(String(url).includes('api.openai.com')){
   const payload=JSON.parse(String(init?.body));const [,count,first]=payload.messages[1].content.match(/Plan (\d+) days, starting (\d{4}-\d{2}-\d{2})/);
   return Response.json({choices:[{message:{content:JSON.stringify({days:Array.from({length:Number(count)},(_,i)=>({day:i+1,date:new Date(Date.parse(first)+i*86400000).toISOString().slice(0,10),theme:'Explore',visits:[]}))})}}]});
  }
  return Response.json({},{status:503});
 });
 const headers={cookie:'travelmate_session='+createSessionToken(user.id,'traveler'),'idempotency-key':'lite-fixture-key'};
 const params=new URLSearchParams({destination:place.label,latitude:String(place.latitude),longitude:String(place.longitude),countryCode:'JP',placeType:'City',checkInDate:'2040-01-01',checkOutDate:'2040-01-03',currency:'JPY',guestNationality:'PH',occupancy:JSON.stringify([{adults:2,childAges:[5]}])});
 const found=await search(new Request('http://localhost/api/accommodations?'+params,{headers}));assert.equal(found.status,200);
 const result=await found.json();assert.equal(result.providerEnvironment,'sandbox');assert.equal(result.providerAccommodations.length,1);
 const selected=result.providerAccommodations[0];assert.equal(selected.quote.total,12345);assert.equal(selected.quote.budgetTotal,12645);
 const body={quoteToken:selected.quoteToken,checkInDate:'2040-01-01',checkOutDate:'2040-01-03',occupancy:[{adults:2,childAges:[5]}]};
 const checked=await check(new Request('http://localhost/api/accommodations/revalidate',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)}));
 assert.equal(checked.status,200);const refreshed=(await checked.json()).accommodation;
 const tripBody={destination:place.label,destinationDetails:{city:place.name,country:place.country,countryCode:'JP',latitude:place.latitude,longitude:place.longitude},latitude:place.latitude,longitude:place.longitude,startDate:body.checkInDate,endDate:body.checkOutDate,budget:100000,currency:'JPY',travelers:3,partyType:'family',rooms:1,selectedAccommodationQuote:refreshed.quoteToken};
 const request=(b:unknown)=>new Request('http://localhost/api/itinerary',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(b)});
 const response=await generate(request(tripBody));const itinerary=await response.json();assert.equal(response.status,200,JSON.stringify(itinerary));
 assert.equal(itinerary.accommodation.listingId,'liteapi:lp123');assert.equal(itinerary.accommodation.source,'liteapi');assert.equal(itinerary.accommodation.total,12645);assert.equal(itinerary.accommodation.providerQuote.total,12345);
 assert.equal(itinerary.grounding.categories.accommodation,24000);assert.equal(itinerary.grounding.accommodation.status,'allowance');assert.equal(verifyGroundedPlan(itinerary),true);
 const saved=parseSavedItinerary(itinerary,{destination:place.label,days:3,startDate:body.checkInDate,budget:100000,currency:'JPY',travelers:3,partyType:'family'});
 assert.equal(saved.accommodation!.providerQuote!.guestNationality,'PH');assert.deepEqual(saved.accommodation!.providerQuote!.photoReferences,['lp123:/hotels/exact.jpg']);
 const expired=await generate(request({...tripBody,endDate:'2040-01-04'}));assert.equal(expired.status,409);
 changed=true;const changedResponse=await generate(request(tripBody));assert.equal(changedResponse.status,409);assert.match((await changedResponse.json()).error,/price or fees changed/);
 assert.ok(calls.every(c=>['/v3.0/data/hotels','/v3.0/data/hotel','/v3.0/data/currencies','/v3.0/hotels/rates'].includes(c.path)));
});
