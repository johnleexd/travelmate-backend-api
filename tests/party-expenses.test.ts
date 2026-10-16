import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { calculateExpense, expenseCoverage, expenseLedger } from '../src/lib/expense-ledger.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import { validateGroundedSchedule } from '../src/services/ai/grounded-schedule.ts';
import type { PartyType } from '../src/schemas/domain.ts';

const anchor = { city: 'Kyoto', country: 'Japan', countryCode: 'JP', latitude: 35.0116, longitude: 135.7681 };
const place = { ...anchor, provider: 'wikidata' as const, placeId: 'Q100', name: 'Recorded test venue', description: 'Schedule fixture', sourceUrl: 'https://www.wikidata.org/wiki/Q100', fetchedAt: '2026-10-16T00:00:00Z', address: '', openingHours: 'Opening hours need confirmation' };
function build(partyType: PartyType, travelers: number) {
  return buildGroundedPlan({ anchor, destination: 'Kyoto, Japan', startingLocation: '', startDate: '2040-01-01', endDate: '2040-01-02', budget: 200000, currency: 'JPY', partyType, travelers, rooms: Math.ceil(travelers / 2),
    places: [place], placeDataStatus: 'live', source: 'catalog', transportation: 'Taxi', transportFare: 3501, transportFareType: 'shared-fare',
    schedule: [1,2].map(day => ({ day, date: `2040-01-0${day}`, theme: 'Recorded schedule', visits: day === 1 ? [{ placeId: place.placeId, startMinutes: 600, durationMinutes: 60, participants: 1 }] : [] })) });
}
for (const [mode, count] of [['solo',1],['couple',2],['family',4],['friends',5]] as const) {
  test(`${mode}/${count}: full-party pricing, shares, saved JSON and manual notes reconcile`, () => {
    const plan = build(mode,count), before = JSON.stringify(plan), review = expenseLedger(plan);
    const visit = plan.days[0].activities[0], rate = visit.priceEvidence!;
    assert.equal(rate.participants,count,'AI hints never underprice the selected party');
    assert.equal(visit.estimatedCost,calculateExpense(rate.unitAmount,rate.quantity,count,rate.unit,'JPY'));
    assert.equal(expenseCoverage(visit,'JPY')!.shares.reduce((a,b)=>a+b,0),visit.estimatedCost);
    assert.equal(review.categories.find(row=>row.key==='transportation')!.amount,3501*2,'shared fare is counted once per day');
    assert.equal(review.categories.find(row=>row.key==='accommodation')!.amount,plan.grounding!.accommodation.unitAmount*Math.ceil(count/2),'room-night quantity already includes nights and rooms');
    assert.equal(review.shares!.reduce((a,b)=>a+b,0),review.total);
    const reopened = parseSavedItinerary(JSON.parse(before),{days:2,currency:'JPY',budget:200000,partyType:mode,travelers:count,startDate:'2040-01-01'});
    assert.equal(expenseLedger(reopened).total,review.total); assert.equal(verifyGroundedPlan(reopened),true);
    const edited = structuredClone(reopened); edited.days[0].activities[0].description='Keep my reminder';
    const savedEdit = applyManualItineraryChanges(reopened,edited,2,200000,count,'JPY') as unknown as typeof plan;
    assert.equal(savedEdit.days[0].activities[0].description,'Keep my reminder');
    assert.equal(expenseLedger(savedEdit).total,review.total); assert.equal(JSON.stringify(plan),before);
  });
}
test('legacy basis stays ambiguous; a stale participant count withholds shares without multiplying a total',()=>{
  const legacy=build('family',4); delete legacy.days[0].activities[0].priceEvidence;
  const before=JSON.stringify(legacy), review=expenseLedger(legacy);
  assert.equal(review.needsBudgetRefresh,true);assert.equal(review.shares,null);assert.equal(expenseCoverage(legacy.days[0].activities[0],'JPY'),null);
  assert.equal(JSON.stringify(legacy),before);
  const old=build('friends',5), total=expenseLedger(old).total;
  const draft=expenseLedger(old,{party:{partyType:'family',travelers:4}});
  assert.equal(draft.partyDraft,true);assert.equal(draft.shares,null);assert.equal(draft.total,total);
  const refreshed=build('family',4);assert.equal(refreshed.travelers,4);assert.equal(refreshed.days[0].activities[0].priceEvidence!.participants,4);
  assert.notEqual(expenseLedger(refreshed).total,total);
});
test('supported quantities, precision and unequal shared amounts reconcile without invented tariffs',()=>{
  for(const unit of ['group','shared-fare','per-room-night','day','night','room','transport-leg'] as const) assert.equal(calculateExpense(101,3,5,unit,'JPY'),303);
  for(const unit of ['per-person','daily-per-person','meal'] as const) assert.equal(calculateExpense(101,3,5,unit,'JPY'),1515);
  const item=build('friends',5).days[0].activities.at(-1)!;
  assert.deepEqual(expenseCoverage(item,'JPY')!.shares,[701,700,700,700,700]);
  assert.equal(expenseCoverage(item,'JPY')!.equalShare,true);
  assert.equal(calculateExpense(1.125,2,5,'per-person','KWD'),11.25);
  assert.throws(()=>build('solo',4),/Traveler count/);assert.throws(()=>build('couple',1),/Traveler count/);
});
test('AI validation requires full-party participation, not the example size in a schema',()=>{
  const raw={days:[{day:1,date:'2040-01-01',theme:'Test',visits:[{placeId:place.placeId,startMinutes:600,durationMinutes:60,participants:1}]}]};
  assert.throws(()=>validateGroundedSchedule(JSON.stringify(raw),[place],'2040-01-01',1,4),/every traveler/);
  raw.days[0].visits[0].participants=4;
  assert.equal(validateGroundedSchedule(JSON.stringify(raw),[place],'2040-01-01',1,4).length,1);
});
test('a transport preference never changes a shared allowance into a per-person charge',()=>{
  const base = build('friends',5);
  for (const transportation of ['Walking','Public transport','Taxi']) {
    const plan = buildGroundedPlan({ anchor, destination:'Kyoto, Japan', startingLocation:'', startDate:'2040-01-01', endDate:'2040-01-02', budget:200000, currency:'JPY', partyType:'friends', travelers:5, rooms:3,
      places:[place], placeDataStatus:'live', source:'catalog', transportation,
      schedule:base.days.map(day=>({day:day.day,date:day.date,theme:day.theme,visits:[]})) });
    const transport=plan.days[0].activities.find(item=>item.category==='transport')!,price=transport.priceEvidence!;
    assert.equal(price.unit,'day');
    assert.equal(transport.estimatedCost,calculateExpense(price.unitAmount,price.quantity,price.participants,price.unit,'JPY'));
    assert.equal(expenseLedger(plan).categories.find(row=>row.key==='transportation')!.amount,price.unitAmount*2);
    parseSavedItinerary(plan,{days:2,currency:'JPY',budget:200000,partyType:'friends',travelers:5,startDate:'2040-01-01'});
  }
});
