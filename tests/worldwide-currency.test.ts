import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUPPORTED_CURRENCIES, CURRENCY_NAMES, destinationCurrencies, currencyFractionDigits, currencyStep, normalizeCurrency, hasValidCurrencyPrecision, formatMoney, sumMoney, roundMoney } from '../src/lib/currency.ts';
import { allocateEqualShares } from '../src/schemas/domain.ts';
import { resolveDestinationContext } from '../src/services/destination/destination-context-service.ts';
import { buildGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { expenseLedger } from '../src/lib/expense-ledger.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { applyExpenseEdits } from '../src/services/itinerary/expense-edits.ts';
import { planningAllowance } from '../src/services/itinerary/planning-estimates.ts';
import { getExchangeRate, clearExchangeRateCache } from '../src/services/currency/exchange-rate-service.ts';
import { normalizeFlightOffers, normalizeActivityOffers } from '../src/services/travel/amadeus-provider.ts';

test('official destination currencies include global and territory currencies without first-currency guesses',()=>{
  for(const [country,code] of Object.entries({CO:'COP',PH:'PHP',JP:'JPY',CN:'CNY',US:'USD',FR:'EUR',KW:'KWD',BH:'BHD',CL:'CLP',PR:'USD',RE:'EUR',CW:'XCG',BG:'EUR'})) assert.equal(resolveDestinationContext(country,'Test city').currency,code);
  assert.deepEqual(destinationCurrencies('PA'),['PAB','USD']);assert.equal(resolveDestinationContext('PA','Panama City').currency,null);
  assert.deepEqual(destinationCurrencies('PS'),['ILS','JOD']);assert.deepEqual(destinationCurrencies('BT'),['BTN','INR']);
  assert.deepEqual(destinationCurrencies('AQ'),[]);assert.deepEqual(destinationCurrencies('ZZ'),[]);
  assert.equal(destinationCurrencies('BG','2025-12-01').includes('EUR'),false);
  assert.ok(SUPPORTED_CURRENCIES.length>150);
  for(const currency of SUPPORTED_CURRENCIES) {assert.equal(normalizeCurrency(currency.toLowerCase()),currency);assert.ok(CURRENCY_NAMES[currency]);}
  assert.throws(()=>normalizeCurrency('XXX'));assert.throws(()=>normalizeCurrency('XTS'));assert.throws(()=>normalizeCurrency('COU'));
});
test('ISO precision, safe minor-unit arithmetic and exact shared remainders cover zero, two and three decimal currencies',()=>{
  assert.equal(currencyFractionDigits('JPY'),0);assert.equal(currencyFractionDigits('CLP'),0);assert.equal(currencyFractionDigits('COP'),2);
  assert.equal(currencyFractionDigits('KWD'),3);assert.equal(currencyStep('BHD'),0.001);
  assert.equal(hasValidCurrencyPrecision(1.234,'KWD'),true);assert.equal(hasValidCurrencyPrecision(1.2345,'KWD'),false);
  assert.equal(hasValidCurrencyPrecision(1.1,'JPY'),false);assert.equal(hasValidCurrencyPrecision(1e20,'COP'),false);
  assert.deepEqual(allocateEqualShares(1.001,3,'KWD'),[0.334,0.334,0.333]);
  assert.equal(sumMoney([0.111,0.222,0.333],'KWD'),0.666);assert.equal(roundMoney(1.005,'COP'),1.01);
  assert.match(formatMoney(1.234,'KWD'),/KWD\s*1\.234/);assert.match(formatMoney(1,'JPY'),/JPY\s*1$/);
  assert.throws(()=>sumMoney([Number.MAX_SAFE_INTEGER],'KWD'),/safe precision/);
});
test('provider amounts retain their currency and three decimal places; missing currency is never labeled PHP',()=>{
  const fetchedAt='2026-10-16T00:00:00Z';
  const flight={id:'currency-test',price:{grandTotal:'1.234',currency:'KWD'},itineraries:[{duration:'PT1H',segments:[{departure:{iataCode:'KWI',at:'2040-01-25T10:00:00'},arrival:{iataCode:'BAH',at:'2040-01-25T11:00:00'}}]}]};
  const normalized=normalizeFlightOffers({data:[flight]},fetchedAt,false);
  assert.equal(normalized[0].price,1.234);assert.equal(normalized[0].currency,'KWD');assert.equal(normalized[0].fetchedAt,fetchedAt);
  assert.deepEqual(normalizeFlightOffers({data:[{...flight,price:{grandTotal:'1.234'}}]},fetchedAt,false),[]);
  assert.equal(normalizeActivityOffers({data:[{id:'a',name:'Source priced activity',price:{amount:'1.234',currencyCode:'OMR'}}]},'Muscat',fetchedAt,false)[0].price,1.234);
  assert.deepEqual(normalizeActivityOffers({data:[{id:'a',name:'Unpriced',price:{amount:'100'}}]},'Muscat',fetchedAt,false),[]);
});
function kuwaitPlan(){
  return buildGroundedPlan({destination:'Kuwait City, Kuwait',anchor:{city:'Kuwait City',country:'Kuwait',countryCode:'KW',latitude:29.37,longitude:47.98},startingLocation:'',startDate:'2040-01-25',endDate:'2040-01-27',budget:6,currency:'KWD',travelers:3,partyType:'friends',rooms:2,source:'catalog',transportation:'',timeZone:'Asia/Kuwait',places:[],placeDataStatus:'unavailable',nightlyRoomEstimate:1.234,foodDailyPerPerson:0.111,transportFare:0.222,transportFareType:'shared-fare',fees:0.123,contingencyPercent:0,schedule:[25,26,27].map((date,index)=>({day:index+1,date:`2040-01-${date}`,theme:'Unscheduled',visits:[],planningStatus:'incomplete'}))});
}
test('three-decimal generation, shared transport, stay-date nights, saving and explicit estimate edits retain exact units',()=>{
  const plan=kuwaitPlan(), review=expenseLedger(plan);
  assert.equal(review.total,6.724);assert.equal(review.remaining,-0.724);assert.equal(review.status,'over-budget');assert.equal(review.nights,2);
  assert.equal(review.categories.find(row=>row.key==='accommodation')!.amount,4.936);
  assert.equal(review.categories.find(row=>row.key==='food')!.amount,0.999);
  assert.equal(review.categories.find(row=>row.key==='transportation')!.amount,0.666);
  const parsed=parseSavedItinerary(plan,{days:3,currency:'KWD',budget:6,travelers:3,partyType:'friends',startDate:'2040-01-25',destination:plan.destination});
  assert.equal(expenseLedger(parsed).total,6.724);
  const original=JSON.stringify(plan), updated=applyExpenseEdits(plan,{foodDailyPerPerson:0.222});
  assert.equal(expenseLedger(updated).total,7.723);assert.equal(JSON.stringify(plan),original);
  assert.throws(()=>applyExpenseEdits(plan,{foodDailyPerPerson:0.1111}),/precision/);
});
test('an omitted transport mode uses the shared daily estimate displayed by the current form',()=>{
  const plan=buildGroundedPlan({destination:'Kuwait City, Kuwait',anchor:{city:'Kuwait City',country:'Kuwait',countryCode:'KW',latitude:29.37,longitude:47.98},startingLocation:'',startDate:'2040-01-25',endDate:'2040-01-25',budget:10,currency:'KWD',travelers:3,partyType:'friends',rooms:1,source:'catalog',transportation:'',places:[],placeDataStatus:'unavailable',transportFare:0.222,contingencyPercent:0,schedule:[{day:1,date:'2040-01-25',theme:'Unscheduled',visits:[],planningStatus:'incomplete'}]});
  assert.equal(expenseLedger(plan).categories.find(row=>row.key==='transportation')!.amount,0.222);
});
test('new COP and uncovered VED plans do not copy another currency’s numeric estimation rules',()=>{
  for(const [currency,country] of [['COP','CO'],['VED','VE']] as const){
    const rule=planningAllowance(country,currency,'food',1,1,'2026-10-16T00:00:00Z');
    assert.equal(rule.status,'unavailable');assert.match(rule.basis,/No destination\/category/);
    const plan=buildGroundedPlan({destination:'Selected city',anchor:{city:'Selected city',country:'Selected country',countryCode:country,latitude:4.6,longitude:-74.08},startingLocation:'',startDate:'2040-01-25',endDate:'2040-01-25',budget:1000000,currency,travelers:1,partyType:'solo',rooms:1,source:'catalog',transportation:'',places:[],placeDataStatus:'unavailable',schedule:[{day:1,date:'2040-01-25',theme:'Unscheduled',visits:[],planningStatus:'incomplete'}]});
    assert.equal(expenseLedger(plan).total,null);
    const entered=applyExpenseEdits(plan,{foodDailyPerPerson:123.45,transportFare:321.23,contingencyPercent:0});
    assert.equal(expenseLedger(entered).total,444.68);assert.equal(entered.currency,currency);
  }
});
test('captured real provider rates are accepted; an ISO currency outside provider coverage remains usable without a fabricated conversion',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/currency-provider-snapshot.json',import.meta.url),'utf8'));
  assert.equal(fixture.coverage.includes('VED'),false);assert.equal(normalizeCurrency('VED'),'VED');
  for(const result of fixture.results){
    clearExchangeRateCache();
    const fetcher=async()=>Response.json(result.payload,{status:result.status});
    if(result.status===200){const quote=await getExchangeRate(result.base,result.quote,fetcher);assert.equal(quote.rate,result.payload.rate);assert.equal(quote.asOf,result.payload.date);}
    else await assert.rejects(()=>getExchangeRate(result.base,result.quote,fetcher),/422/);
  }
});
