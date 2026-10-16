import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccommodationPlaces, searchAccommodationPlaces } from '../src/services/destination/accommodation-places.ts';
import { normalizeItinerary, type ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import { splitBudget } from '../src/schemas/domain.ts';
import { createOfferToken, verifyOfferToken } from '../src/utils/offer-token.ts';

for (const [destination, latitude, longitude, countryCode] of [['Kyoto',35.01,135.77,'JP'],['Paris',48.86,2.35,'FR'],['Cape Town',-33.92,18.42,'ZA'],['Cebu',10.32,123.9,'PH']] as const) {
  test(`${destination}: nearby listings use coordinates and source types without fabricated prices`, async () => {
    const previous = process.env.ACCOMMODATION_PLACES_URL;
    process.env.ACCOMMODATION_PLACES_URL = 'https://overpass.example.test/api/interpreter';
    try {
      let query = '';
      const result = await searchAccommodationPlaces({ destination, latitude, longitude, countryCode }, async (_input, init) => {
        query = String(init?.body);
        return Response.json({ elements: ['hotel','hostel','guest_house','resort'].map((tourism,index) => ({ type:'node', id:index+1, lat:latitude+0.001*index, lon:longitude, tags:{ name:`${destination} property ${index}`,tourism,'addr:city':destination,'addr:country':countryCode } })) });
      });
      assert.equal(result.value.length,4);
      assert.match(decodeURIComponent(query),new RegExp(`${latitude},${longitude}`.replaceAll('.', '\\.')));
      assert.ok(result.value.every(stay => !('nightlyRate' in stay) && !('available' in stay) && stay.source === 'openstreetmap'));
      assert.deepEqual(result.value.map(stay=>stay.type),['Hotel','Hostel','Guesthouse','Resort']);
    } finally { if(previous === undefined) delete process.env.ACCOMMODATION_PLACES_URL; else process.env.ACCOMMODATION_PLACES_URL=previous; }
  });
}
test('deduplicates node/way listings and excludes invalid coordinates, distant and wrong-country records', () => {
  const valid = {type:'node',id:1,lat:35,lon:135,tags:{name:'Central Hotel',tourism:'hotel','addr:country':'JP'}};
  const rows=normalizeAccommodationPlaces({elements:[valid, {...valid,type:'way',id:2,lat:35.00001}, {...valid,id:3,lat:55}, {...valid,id:4,lat:NaN}, {...valid,id:5,tags:{...valid.tags,'addr:country':'FR'}}]}, {destination:'Kyoto',latitude:35,longitude:135,countryCode:'JP'});
  assert.equal(rows.length,1);
});
test('signed room quotes cannot be reused with other dates, travelers, destination or group total', () => {
  const offer={hotelId:'h',offerId:'o',name:'Hotel',nightlyRate:50,currency:'USD',isLive:true,total:100,destination:'Paris, France',checkInDate:'2040-01-01',checkOutDate:'2040-01-03',adults:2,latitude:48.86,longitude:2.35};
  const token=createOfferToken(offer);
  assert.equal(verifyOfferToken(offer,token),true);
  for(const patch of [{adults:3},{total:101},{destination:'Kyoto, Japan'},{checkOutDate:'2040-01-04'}]) assert.equal(verifyOfferToken({...offer,...patch},token),false);
});
test('quoted group accommodation total is counted once and survives saving and editing without rounding loss', () => {
  const itinerary={destination:'Paris, France',totalBudget:1000,currency:'USD',source:'mock',days:Array.from({length:3},(_,i)=>({day:i+1,date:'2040-01-01',theme:'Explore',imageUrl:'',totalCost:0,activities:[{time:'09:00',title:'Food',description:'Eat',category:'food',icon:'food',estimatedCost:10},{time:'20:00',title:'Stay',description:'Return',category:'accommodation',icon:'bed',estimatedCost:100}]})),budgetSummary:splitBudget(1000,2,3)} as ItineraryResponse;
  const normalized=normalizeItinerary(itinerary,splitBudget(1000,2,3),'couple',2,3,'2040-01-01',{listingId:'amadeus:h',name:'Central Hotel',address:'Paris',nightlyRate:50.01,quotedTotal:100.01,currency:'USD',source:'amadeus'});
  assert.equal(normalized.accommodation?.total,100.01);
  assert.equal(normalized.budgetSummary.accommodationActual,100.01);
  assert.equal(normalized.budgetSummary.plannedSpend,160.01);
  assert.deepEqual(normalized.days.map(day=>day.totalCost),[70.01,70,20]);
  parseSavedItinerary(normalized,{days:3,currency:'USD',budget:1000,travelers:2,partyType:'couple'});
  const edited=applyManualItineraryChanges(normalized,normalized,3,1000,2,'USD');
  assert.equal((edited.budgetSummary as {plannedSpend:number}).plannedSpend,100.01);
  assert.deepEqual((edited.days as {totalCost:number}[]).map(day=>day.totalCost),[50.01,50,0]);
  const unpriced={...normalizeItinerary(itinerary,splitBudget(1000,2,3),'couple',2,3,'2040-01-01'),plannedAccommodation:{name:'Mapped Guesthouse',address:'Paris',type:'Guesthouse',source:'openstreetmap' as const,sourceId:'osm:node:123'}};
  assert.equal(unpriced.budgetSummary.accommodationActual,0);
  assert.equal(unpriced.accommodation,undefined);
  const saved=parseSavedItinerary(unpriced,{days:3,currency:'USD',budget:1000,travelers:2,partyType:'couple'});
  assert.deepEqual(saved.plannedAccommodation,unpriced.plannedAccommodation);
  assert.deepEqual(applyManualItineraryChanges(saved,saved,3,1000,2,'USD').plannedAccommodation,unpriced.plannedAccommodation);
});
