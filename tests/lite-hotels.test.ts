import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {LiteHotelProvider,liteQuote,litePhotos,liteRoomSignature} from '../src/services/travel/lite-hotel-provider.ts';
import {openQuote,type QuoteTicket} from '../src/services/travel/hotel-quote.ts';
import {normalizeItinerary} from '../src/controllers/itinerary-controller.ts';
import {parseSavedItinerary} from '../src/services/itinerary/saved-trip-schema.ts';
import {splitBudget} from '../src/schemas/domain.ts';
const previous=process.env.ACCOMMODATION_QUOTE_SECRET;
process.env.ACCOMMODATION_QUOTE_SECRET='fixture-only-recommendation-secret-longer-than-32-characters';
after(()=>{if(previous===undefined)delete process.env.ACCOMMODATION_QUOTE_SECRET;else process.env.ACCOMMODATION_QUOTE_SECRET=previous;});
const env={LITEAPI_API_KEY:'sand_fixture',LITEAPI_ENV:'sandbox'};
const input={destination:'Yokohama',countryCode:'JP',latitude:35.44,longitude:139.64,checkInDate:'2040-01-01',checkOutDate:'2040-01-03',currency:'USD',guestNationality:'PH',occupancy:[{adults:2,childAges:[5]},{adults:1,childAges:[]}]};
const hotel=(id='lp123')=>({id,name:'Official English Property',address:'1 Harbor Street, Yokohama',country:'JP',latitude:35.44,longitude:139.64,main_photo:'https://static.cupid.travel/hotels/'+id+'.jpg'});
const offer=()=>({offerId:'provider-offer-reference'.repeat(40),roomTypeId:'type',offerRetailRate:{amount:223.30,currency:'USD'},rates:input.occupancy.map((room,i)=>({
 mappedRoomId:i+100,name:'Family room',boardType:'RO',adultCount:room.adults,childCount:room.childAges.length,childrenAges:room.childAges,
 retailRate:{total:[{amount:i?99.90:123.40,currency:'USD'}],taxesAndFees:[{included:true,description:'Sales tax',amount:5,currency:'USD'},{included:false,description:'Facility fee',amount:10,currency:'USD'}]},
 cancellationPolicies:{refundableTag:'RFN'},
}))});
function fake(fetchRates?: (body:any)=>Response, fetchDetails?: (id:string)=>any) {
 const calls:{path:string;body?:any}[]=[];
 const provider=new LiteHotelProvider(env,async(url,init)=>{
  const parsed=new URL(String(url)),body=init?.body?JSON.parse(String(init.body)):undefined;
  calls.push({path:parsed.pathname,body});
  assert.equal(parsed.origin,'https://api.liteapi.travel');
  assert.equal((init?.headers as Record<string,string>)['X-API-Key'],'sand_fixture');
  assert.equal(init?.cache,'no-store');assert.equal(init?.redirect,'error');
  if(parsed.pathname==='/v3.0/data/currencies')return Response.json({data:[{code:'USD'},{code:'JPY'}]});
  if(parsed.pathname==='/v3.0/data/hotels') {assert.equal(parsed.searchParams.get('language'),'en');return Response.json({data:[hotel(),{...hotel('lp999'),latitude:1,longitude:103,country:'SG'}]});}
  if(parsed.pathname==='/v3.0/data/hotel') {assert.equal(parsed.searchParams.get('language'),'en');return Response.json({data:fetchDetails?.(parsed.searchParams.get('hotelId')!)||{...hotel(),hotelImages:[{url:'https://static.cupid.travel/hotels/exact.jpg',defaultImage:true},{url:'https://static.cupid.travel/hotels/room.jpg'}],hotelFacilities:['WiFi'],starRating:4}});}
  assert.equal(parsed.pathname,'/v3.0/hotels/rates');
  return fetchRates?.(body)||Response.json({sandbox:true,data:[{hotelId:'lp123',roomTypes:[offer()]},{hotelId:'lp999',roomTypes:[offer()]}]});
 });
 return {provider,calls};
}
test('English hotel IDs join photos and full multi-room totals; no booking requests',async()=>{
 const {provider,calls}=fake();const rows=await provider.search(input,'traveler');
 assert.equal(rows.length,1);assert.equal(rows[0].propertyId,'lp123');assert.equal(rows[0].name,'Official English Property');
 assert.equal(rows[0].photos.length,3);assert.ok(rows[0].photos.every(p=>p.reference.startsWith('lp123:')));
 const q=rows[0].quote!;assert.equal(q.total,223.30);assert.equal(q.nightlyAverage,111.65);assert.equal(q.budgetTotal,243.30);
 assert.equal(q.isLive,false);assert.equal(rows[0].environment,'sandbox');assert.equal(q.taxesAndFeesIncluded,false);
 assert.equal(q.payableAtProperty.length,2);assert.equal(q.guestNationality,'PH');
 assert.deepEqual(calls.find(c=>c.body)?.body.occupancies,[{adults:2,children:[5]},{adults:1,children:[]}]);
 assert.deepEqual(calls.find(c=>c.body)?.body.hotelIds,['lp123']);assert.equal(calls.find(c=>c.body)?.body.guestNationality,'PH');
 const ticket=openQuote(rows[0].quoteToken,'traveler');assert.equal(ticket.property.quote!.offerId.length>200,true);
 assert.throws(()=>openQuote(rows[0].quoteToken,'other'),/invalid/);
});
test('exact ID mismatch and unapproved photo sources never supply photos',async()=>{
 assert.deepEqual(litePhotos({...hotel(),id:'lpother'},'lp123'),[]);
 assert.deepEqual(litePhotos({...hotel(),main_photo:'https://random.test/image.jpg'},'lp123'),[]);
 const {provider}=fake(undefined,()=>({...hotel('lpwrong'),name:'Wrong property',hotelImages:[{url:'https://static.cupid.travel/wrong.jpg'}]}));
 const [row]=await provider.search(input,'traveler');assert.equal(row.name,'Official English Property');assert.ok(row.photos.every(p=>!p.url.includes('wrong')));
});
test('actual occupancy, complete totals and original currency are required',()=>{
 const invalid=offer();invalid.rates[0].adultCount=1;
 assert.equal(liteQuote(invalid,'lp123',input,[],new Date().toISOString()),undefined);
 const mismatch=offer();mismatch.offerRetailRate.amount=1;assert.equal(liteQuote(mismatch,'lp123',input,[],new Date().toISOString()),undefined);
 const currency=offer();currency.offerRetailRate.currency='EUR';assert.equal(liteQuote(currency,'lp123',input,[],new Date().toISOString()),undefined);
 const missing=offer();delete (missing as any).offerRetailRate;assert.equal(liteQuote(missing,'lp123',input,[],new Date().toISOString()),undefined);
});
test('fee disclosure remains unknown if absent; cross-currency property fees are not silently totaled',()=>{
 const absent=offer();for(const rate of absent.rates)delete (rate.retailRate as any).taxesAndFees;
 const q=liteQuote(absent,'lp123',input,[],new Date().toISOString())!;
 assert.equal(q.taxesAndFeesIncluded,undefined);
 const mixed=offer();mixed.rates[0].retailRate.taxesAndFees[1].currency='JPY';
 const m=liteQuote(mixed,'lp123',input,[],new Date().toISOString())!;
 assert.equal(m.budgetTotal,undefined);assert.equal(m.payableAtProperty[0].currency,'JPY');
});
test('missing guest nationality returns honest content without making a rate request',async()=>{
 const {provider,calls}=fake();const rows=await provider.search({...input,guestNationality:''},'traveler');
 assert.equal(rows[0].quote,undefined);assert.equal(rows[0].availability,'unavailable');
 assert.equal(calls.some(c=>c.body),false);
});
test('empty availability, explicitly sold-out offers and provider errors remain distinct',async()=>{
 for(const [response,expected] of [[{sandbox:true,data:[]},'unavailable'],[{sandbox:true,data:[{hotelId:'lp123',status:'sold_out'}]},'sold-out'],[{error:{code:429}},'provider-error']] as const) {
  const {provider}=fake(()=>Response.json(response,{status:expected==='provider-error'?429:200}));
  const rows=await provider.search(input,'traveler');assert.equal(rows[0].availability,expected);assert.equal(rows[0].quote,undefined);
  if(expected==='provider-error')assert.match(rows[0].providerMessage!,/rate limit/);
 }
});
test('invalid credentials, timeouts and unknown environments are sanitized without exposing keys',async()=>{
 assert.throws(()=>new LiteHotelProvider({...env,LITEAPI_API_KEY:'prod_fixture'}),/sandbox API key/);
 assert.throws(()=>new LiteHotelProvider({...env,LITEAPI_ENV:'production'}),/disabled/);
 for(const mode of ['invalid','timeout','rate-limit']) {
  const provider=new LiteHotelProvider(env,async()=>{if(mode==='timeout')throw new DOMException('secret debug detail','TimeoutError');return Response.json({error:{code:mode==='invalid'?401:429,message:'sand_fixture'}},{status:mode==='invalid'?401:429});});
  await assert.rejects(provider.search(input,'traveler'),error=>{assert.ok(!String(error).includes('sand_fixture'));assert.match(String(error),/credentials|timed out|rate limit/);return true;});
 }
});
test('search-only recheck uses same property, dates, nationality, occupancy and session; detects changes',async()=>{
 const {provider,calls}=fake();const [row]=await provider.search(input,'traveler');const ticket=openQuote(row.quoteToken,'traveler');
 const refreshed=await provider.revalidate(ticket);assert.equal(refreshed.quote!.total,row.quote!.total);assert.ok(refreshed.quote!.revalidatedAt);
 assert.equal(calls.filter(c=>c.body).at(-1)!.body.sessionId,calls.find(c=>c.body)!.body.sessionId);
 const changed=offer();changed.offerRetailRate.amount+=1;changed.rates[0].retailRate.total[0].amount+=1;
 const {provider:other}=fake(()=>Response.json({sandbox:true,data:[{hotelId:'lp123',roomTypes:[changed]}]}));
 await assert.rejects(other.revalidate(ticket),/price or fees changed/);
 const {provider:missing}=fake(()=>Response.json({sandbox:true,data:[{hotelId:'lpwrong',roomTypes:[offer()]}]}));
 await assert.rejects(missing.revalidate(ticket),/unavailable/);
 const {provider:unverified}=fake(()=>Response.json({sandbox:false,data:[{hotelId:'lp123',roomTypes:[offer()]}]}));
 await assert.rejects(unverified.revalidate(ticket),/sandbox test data/);
});
test('date changes are sent to the provider and bound to the resulting quote',async()=>{
 const {provider,calls}=fake();const changed={...input,checkInDate:'2041-02-01',checkOutDate:'2041-02-04'};
 const [row]=await provider.search(changed,'traveler');
 assert.equal(row.quote!.checkInDate,changed.checkInDate);assert.equal(row.quote!.checkOutDate,changed.checkOutDate);
 assert.equal(calls.find(c=>c.body)!.body.checkout,changed.checkOutDate);
});
test('saved itinerary keeps provider property, offer, photos and quote; budgets additional property fees once',()=>{
 const quote=liteQuote(offer(),'lp123',input,litePhotos(hotel(),'lp123'),new Date().toISOString())!;
 const budget=1000,days=3,split=splitBudget(budget,4,days);
 const accommodation={listingId:'liteapi:lp123',offerId:quote.offerId,name:'Official English Property',address:'Yokohama',nightlyRate:quote.nightlyAverage,nights:2,rooms:2,total:quote.budgetTotal!,quotedTotal:quote.budgetTotal!,currency:'USD' as const,source:'liteapi' as const,isLive:false,providerQuote:quote};
 const raw:any={destination:'Yokohama',totalBudget:budget,currency:'USD',source:'mock',accommodation,days:Array.from({length:days},(_,i)=>({day:i+1,date:'2040-01-0'+(i+1),theme:'Explore',imageUrl:'',activities:[],totalCost:0})),budgetSummary:{...split,total:budget,dailyAverage:0}};
 const normalized=normalizeItinerary(raw,split,'family',4,days,input.checkInDate,{...accommodation,source:'liteapi',quotedTotal:quote.budgetTotal});
 const saved=parseSavedItinerary(normalized,{destination:'Yokohama',days,travelers:4,currency:'USD',budget,partyType:'family',startDate:input.checkInDate});
 assert.equal(saved.accommodation!.total,243.30);assert.equal(saved.accommodation!.providerQuote!.total,223.30);
 assert.equal(saved.accommodation!.providerQuote!.photoReferences[0],'lp123:/hotels/lp123.jpg');
 assert.equal(saved.accommodation!.source,'liteapi');
});
