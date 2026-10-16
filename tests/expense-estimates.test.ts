import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGroundedPlan, calculateExpense, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { applyExpenseEdits } from '../src/services/itinerary/expense-edits.ts';
import { expenseLedger } from '../src/lib/expense-ledger.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { planningAllowance } from '../src/services/itinerary/planning-estimates.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import type { ItineraryResponse } from '../src/controllers/itinerary-controller.ts';

const anchor = { city: 'Manila', country: 'Philippines', countryCode: 'PH', latitude: 14.6, longitude: 120.98 };
function plan(extra: Partial<Parameters<typeof buildGroundedPlan>[0]> = {}) {
  return buildGroundedPlan({ destination: 'Manila, Philippines', anchor, startingLocation: '', startDate: '2040-01-25', endDate: '2040-01-27', budget: 50000, currency: 'PHP', travelers: 3, partyType: 'friends', rooms: 2, source: 'catalog', transportation: '', placeDataStatus: 'live',
    places: [{ provider: 'wikidata', placeId: 'Q100', name: 'Recorded museum', description: 'museum', ...anchor, sourceUrl: 'https://www.wikidata.org/wiki/Q100', fetchedAt: '2026-10-16T00:00:00Z', address: 'Recorded address', openingHours: 'Opening hours need confirmation' }],
    schedule: [0,1,2].map(index=>({ day: index+1, date: `2040-01-${25+index}`, theme: 'Day', visits: index ? [] : [{ placeId: 'Q100', startMinutes: 600, durationMinutes: 60, participants: 3 }] })), ...extra });
}
const context = { days: 3, budget: 50000, currency: 'PHP' as const, travelers: 3, partyType: 'friends' as const, startDate: '2040-01-25' };
test('fixed allowances cover categories without allocating the budget or inventing venue prices', () => {
  const value=plan(), review=expenseLedger(value);
  assert.deepEqual(value.grounding!.categories, { accommodation: 8000, food: 5400, transportation: 1800, activities: 900, fees: 0, contingency: 1610 });
  assert.equal(review.total,17710); assert.equal(review.allowanceTotal,17710);
  assert.equal(value.grounding!.nights,2); assert.equal(review.days.reduce((sum,day)=>sum+day.amount!,0),16100);
  assert.equal(expenseLedger(plan({ budget: 100 })).total,17710);
  assert.equal(expenseLedger(plan({ budget: 100 })).status,'over-budget');
  assert.ok(value.days[0].activities[0].priceEvidence!.basis.includes('not an entrance fee'));
  assert.equal(parseSavedItinerary(value,context).grounding!.total,17710);
});
test('user amounts precede other estimates; shared/day and person units extend exactly once', () => {
  const value=plan({ nightlyRoomEstimate: 500, foodDailyPerPerson:100, transportFare:200, transportFareType:'shared-fare' });
  assert.equal(value.grounding!.categories.accommodation,2000); assert.equal(value.grounding!.categories.food,900); assert.equal(value.grounding!.categories.transportation,600); assert.equal(value.grounding!.total,4840);
  assert.equal(calculateExpense(25,3,3,'meal','PHP'),225);
  assert.equal(calculateExpense(25,2,3,'transport-leg','PHP'),50);
});
test('daily envelopes cover itemized meals and fares, repeated allowances do not add charges', () => {
  const value=plan(); const day=value.days[0];
  day.activities.push({ title:'Meal entered by user', time:'Flexible', category:'food', icon:'food', description:'', estimatedCost:1200 });
  day.activities.push(structuredClone(day.activities.find(item=>item.category==='food')!));
  const review=expenseLedger(value);
  assert.equal(review.categories.find(item=>item.key==='food')!.amount,5400);
  assert.equal(review.days[0].rows.filter(row=>row.item.category==='food').reduce((sum,row)=>sum+row.amount!,0),1800);
  assert.equal(review.days[0].rows.at(-1)!.amount,0);
});
test('unsupported currency stays unpriced; no fake conversion, zero or free fee is supplied', () => {
  const rule=planningAllowance('PH','USD','visit',1,1,'2026-10-16T00:00:00Z'); assert.equal(rule.status,'unavailable');
  const value=plan({ currency:'USD' }), review=expenseLedger(value);
  assert.equal(review.total,null); assert.equal(review.status,'incomplete');
  assert.equal(value.days[0].activities[0].priceEvidence!.status,'unavailable');
});
test('explicit estimate saves preserve provider/history objects and round-trip without regeneration', () => {
  const value=plan(), historical=structuredClone(value), updated=applyExpenseEdits(value,{ nightlyRoomEstimate:700,rooms:2,foodDailyPerPerson:100,transportFare:200,transportFareType:'shared-fare' });
  assert.deepEqual(value,historical); assert.equal(updated.accommodationEstimate!.source,'user-entered');
  assert.equal(updated.days[0].activities[0].estimatedCost,900); assert.equal(updated.days[0].activities[0].place!.placeId,'Q100');
  assert.equal(updated.grounding!.categories.accommodation,2800); assert.equal(verifyGroundedPlan(updated),true);
  assert.equal(parseSavedItinerary(updated,context).accommodationEstimate!.unitAmount,700);
  assert.throws(()=>applyExpenseEdits(value,{ nightlyRoomEstimate: -1 }));
  const roomEdit=applyExpenseEdits(value,{rooms:3});
  assert.equal(roomEdit.grounding!.categories.accommodation,12000);assert.equal(roomEdit.grounding!.accommodation.status,'allowance');
  const noteEdit=structuredClone(value);noteEdit.days[0].activities[1].description='Keep my dietary reminder';
  const foodEdit=applyExpenseEdits(noteEdit,{foodDailyPerPerson:150});
  assert.equal(foodEdit.days[0].activities[1].description,'Keep my dietary reminder');
});
test('same-day stay has zero nights; sandbox rates remain separate from generic allowances', () => {
  const one=plan({ endDate:'2040-01-25',schedule:[{ day:1,date:'2040-01-25',theme:'Day',visits:[] }] }); assert.equal(one.grounding!.nights,0); assert.equal(one.grounding!.categories.accommodation,0);
  const sandbox=plan({ accommodation:{ listingId:'test',name:'Test property',address:'Manila',nightlyRate:1,nights:2,total:2,currency:'PHP',source:'amadeus',isLive:false } });
  assert.equal(sandbox.accommodation!.total,2); assert.equal(sandbox.grounding!.categories.accommodation,8000); assert.equal(sandbox.grounding!.accommodation.status,'allowance');
  assert.match(sandbox.grounding!.accommodation.basis,/not a rate/);
});

test('legacy activity editing preserves entered amounts and saves overlapping envelopes with one shared total', () => {
  const item=(title:string,category:'food'|'activity',amount:number,time='Flexible')=>({title,category,estimatedCost:amount,time,icon:category,description:''});
  const legacy:ItineraryResponse={ destination:'Manila, Philippines',currency:'PHP',totalBudget:5000,travelers:3,partyType:'friends',
    days:[{day:1,date:'2040-01-25',theme:'Historical day',imageUrl:'',totalCost:900,activities:[item('Daily meals allowance','food',600,'Daily allowance'),item('My meal','food',200),item('My visit','activity',100)]}],
    budgetSummary:{accommodation:0,food:600,activities:100,transport:0,reserve:0,dailyAverage:900,total:5000} };
  const submitted=structuredClone(legacy);submitted.days[0].activities[1].estimatedCost=250;
  const edited=applyManualItineraryChanges(legacy,submitted,1,5000,3,'PHP') as unknown as ItineraryResponse;
  assert.equal(edited.days[0].activities[1].estimatedCost,250);assert.equal(edited.days[0].activities[1].priceEvidence!.unit,'group');
  assert.equal(edited.days[0].totalCost,250);assert.equal(expenseLedger(edited).total,250);assert.equal(expenseLedger(edited).needsBudgetRefresh,true);
  const saved=parseSavedItinerary(edited,{...context,days:1,budget:5000});assert.equal(expenseLedger(saved).total,250);
  assert.equal(legacy.days[0].activities[1].estimatedCost,200);
});
test('reliable admission references precede visit allowances and user room estimates precede source quotes', () => {
  const base=plan(), place={...base.days[0].activities[0].place!,description:'museum',admission:{amount:50,currency:'PHP' as const,sourceUrl:'https://www.wikidata.org/wiki/Q100#P2555',fetchedAt:'2026-10-15T00:00:00Z'}};
  const value=plan({places:[place],nightlyRoomEstimate:700,accommodation:{listingId:'known',name:'Recorded property',address:'Manila',nightlyRate:5000,nights:2,total:10000,currency:'PHP',source:'travelmate'}});
  assert.equal(value.days[0].activities[0].estimatedCost,150);assert.equal(value.days[0].activities[0].priceEvidence!.status,'estimate');
  assert.equal(value.days[0].activities[0].priceEvidence!.fetchedAt,'2026-10-15T00:00:00Z');
  assert.equal(value.grounding!.categories.accommodation,2800);assert.equal(value.accommodation!.total,10000);
});
