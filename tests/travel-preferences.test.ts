import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generationPreferencesSchema, travelStyles, preferenceInstructions } from '../src/services/itinerary/travel-preferences.ts';
import { completeGroundedSchedule } from '../src/services/itinerary/generated-day-scheduler.ts';
import { buildGroundedPlan, verifyGroundedPlan } from '../src/services/itinerary/grounded-plan.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { retrieveGroundedPlaces, admissionReference, type GroundedPlace } from '../src/services/itinerary/grounded-places.ts';
import { destinationReferences, referenceFetcher } from './helpers/multi-destination-references.ts';
import { prisma } from '../src/lib/prisma.ts';
import { beginGeneration, POST } from '../src/controllers/itinerary-controller.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { normalizeInterests } from '../src/lib/trip-preferences.ts';

test('unified interests merge legacy lists without duplicates or mutation; blank interests remain optional', () => {
 const legacy = ['Food', 'culture'];
 assert.deepEqual(normalizeInterests(legacy, [' food ', 'nature'], ['CULTURE', 'snorkeling']), ['Food', 'culture', 'nature', 'snorkeling']);
 assert.deepEqual(legacy, ['Food', 'culture']);
 assert.deepEqual(generationPreferencesSchema.parse({ interests: ' , ' }).interests, []);
 assert.deepEqual(generationPreferencesSchema.parse({ interests: ['Food'], activities: ['food', 'snorkeling'] }).interests, ['Food', 'snorkeling']);
 assert.equal(generationPreferencesSchema.safeParse({ travelStyle: 'unsupported' }).success, false);
 assert.equal(generationPreferencesSchema.safeParse({ interests: [42] }).success, false);
});

test('omitted and empty retired preferences are accepted for every Travel style', () => {
 for (const travelStyle of travelStyles) for (const value of [undefined, [], '', '   ', null]) {
  const result = generationPreferencesSchema.parse({ travelStyle, interests: value, activities: value });
  assert.equal(result.travelStyle, travelStyle);
  assert.deepEqual(result.interests, []);
  assert.deepEqual(result.activities, []);
 }
});
after(()=>prisma.$disconnect());
const anchor=destinationReferences[0].anchor;
const base:GroundedPlace={provider:'wikidata',placeId:'Q100',name:'Reference museum',description:'museum',city:anchor.city,country:anchor.country,countryCode:anchor.countryCode,latitude:anchor.latitude,longitude:anchor.longitude,sourceUrl:'https://www.wikidata.org/wiki/Q100',fetchedAt:'2026-10-14T00:00:00Z',address:'Confirm address',openingHours:'Opening hours need confirmation'};
const reference=(id:number,name:string,description:string,fee?:number):GroundedPlace=>({...base,placeId:`Q${id}`,name,description,...(fee!==undefined?{admission:{amount:fee,currency:'EUR',sourceUrl:`https://www.wikidata.org/wiki/Q${id}#P2555`,fetchedAt:base.fetchedAt}}:{})});
const catalogue=[reference(100,'Free museum','museum',0),reference(101,'Admission museum','museum',20),reference(102,'Premium opera','premium opera',50),reference(103,'Garden','park garden'),reference(104,'Market','food market'),reference(105,'Unknown museum','museum')];
const schedule=(style:typeof travelStyles[number],places=catalogue,extra={})=>completeGroundedSchedule(anchor,places,[],'2040-01-25',1,1,'balanced',{travelStyle:style,transportation:'taxi',currency:'EUR',visitBudget:100,...extra});
test('all styles make relevant choices/pacing without fabricated price differences',()=>{
 const plans=Object.fromEntries(travelStyles.map(style=>[style,schedule(style)]));
 assert.equal(plans.budget[0].visits[0].placeId,'Q100');
 assert.equal(plans.luxury[0].visits[0].placeId,'Q102');
 const unknownPremium={...catalogue[2],admission:undefined};
 assert.equal(schedule('luxury',[catalogue[0],unknownPremium],{interests:['museum']})[0].visits[0].placeId,'Q100','unpriced premium must not outrank a suitable museum as an affordable luxury choice');
 assert.equal(plans['family-friendly'][0].visits[0].placeId,'Q100');
 assert.equal(plans.balanced[0].visits.length,3);
 for(const style of ['comfort','luxury','family-friendly'])assert.equal(plans[style][0].visits.length,2);
 const gap=(style:string)=>plans[style][0].visits[1].startMinutes-plans[style][0].visits[0].startMinutes-plans[style][0].visits[0].durationMinutes;
 assert.ok(gap('comfort')>gap('balanced'));assert.ok(gap('family-friendly')>gap('comfort'));
 assert.ok(plans['family-friendly'][0].scheduleBlocks?.some(block=>block.kind==='meal'));
 assert.match(preferenceInstructions(generationPreferencesSchema.parse({travelStyle:'family-friendly'})),/Do not assume children/);
 assert.ok(!schedule('luxury',catalogue,{visitBudget:10})[0].visits.some(v=>v.placeId==='Q102'));
 assert.ok(schedule('budget',[catalogue[5]],{visitBudget:0})[0].visits.length===1,'unknown fee/hours/photo must remain selectable');
 assert.ok(schedule('budget',[catalogue[1]],{visitBudget:0,committedActivityNames:['Admission museum']})[0].visits.length===1,'already committed admission is not charged twice');
});
test('interests and requested activities independently change ranking; transport changes real schedule assumptions',()=>{
 assert.equal(schedule('balanced',catalogue,{preferredActivities:['local food']})[0].visits[0].placeId,'Q104');
 assert.equal(schedule('balanced',catalogue,{interests:['food']})[0].visits[0].placeId,'Q104');
 assert.equal(schedule('balanced',catalogue,{preferredActivities:['opera']})[0].visits[0].placeId,'Q102');
 const nearby=[{...catalogue[0],latitude:anchor.latitude+0.05,locationScope:'city' as const}];
 const taxi=schedule('balanced',nearby,{transportation:'taxi'}),walk=schedule('balanced',nearby,{transportation:'walking'});
 assert.ok(taxi[0].visits[0].startMinutes<walk[0].visits[0].startMinutes);
 const plan=buildGroundedPlan({destination:anchor.city,anchor,startingLocation:'',startDate:'2040-01-25',endDate:'2040-01-25',budget:1000,currency:'EUR',travelers:2,partyType:'friends',rooms:1,places:catalogue,placeDataStatus:'live',source:'catalog',transportation:'taxi',schedule:schedule('balanced',[catalogue[1]]),foodDailyPerPerson:12,transportFare:30,transportFareType:'shared-fare'});
 assert.equal(plan.grounding?.categories.food,24);assert.equal(plan.grounding?.categories.transportation,30);assert.ok(plan.grounding!.total<1000);
 assert.equal(plan.days[0].activities.find(a=>a.place?.placeId==='Q101')?.unitCost,20);
});
test('admission adapter accepts unique currency references, rejects conditional/ambiguous prices',()=>{
 const claim=(amount:string)=>({mainsnak:{datavalue:{value:{amount,unit:'http://www.wikidata.org/entity/Q4916'}}}});
 const units={Q4916:{claims:{P498:[{mainsnak:{datavalue:{value:'EUR'}}}]}}};
 assert.equal(admissionReference({claims:{P2555:[claim('+20')]}},units,'Q100',base.fetchedAt)?.amount,20);
 assert.equal(admissionReference({claims:{P2555:[claim('+20'),claim('+10')]}},units,'Q100',base.fetchedAt),undefined);
 assert.equal(admissionReference({claims:{P2555:[{...claim('+10'),qualifiers:{P518:[{}]}}]}},units,'Q100',base.fetchedAt),undefined);
});

test('actual affected Cordova records and international references replay all styles and persist preferences',async()=>{
 const affected=JSON.parse(readFileSync(new URL('./fixtures/preference-affected-cordova.json',import.meta.url),'utf8'));
 const cordova=affected.places as GroundedPlace[];
 cordova.forEach(p=>p.description=p.description.replace(/^Nearby attraction[\s\S]*?confirm the actual route and transport\. /,'').replace(/Opening hours need confirmation\. /,'').split('. Suggested ')[0]);
 const cases=[{anchor:affected.anchor,places:cordova,currency:'PHP' as const,start:'2026-10-14',count:10,budget:30000},...await Promise.all(destinationReferences.map(async r=>({anchor:r.anchor,places:await retrieveGroundedPlaces(r.anchor,referenceFetcher(r)),currency:r.anchor.countryCode==='JP'?'JPY' as const:r.anchor.countryCode==='PH'?'PHP' as const:r.anchor.countryCode==='PN'?'NZD' as const:'EUR' as const,start:'2040-01-25',count:3,budget:100000})))];
 const results=[];
 for(const c of cases)for(const travelStyle of travelStyles){
  const preferences=generationPreferencesSchema.parse({travelStyle,transportation:'taxi',interests:['food','culture','nature'],activities:['local food','sightseeing'],accommodation:'resort'});
  const diagnostics:unknown[]=[];
  const days=completeGroundedSchedule(c.anchor,c.places,[],c.start,c.count,1,'balanced',{...preferences,preferredActivities:preferences.activities,currency:c.currency,visitBudget:c.budget/1.1,diagnostics:e=>diagnostics.push(e)});
  const endDate=new Date(Date.parse(c.start)+(c.count-1)*86400000).toISOString().slice(0,10);
  const plan=buildGroundedPlan({destination:c.anchor.city,anchor:c.anchor,startingLocation:'',startDate:c.start,endDate,budget:c.budget,currency:c.currency,travelers:1,partyType:'solo',rooms:1,places:c.places,placeDataStatus:'fresh-cache',source:'catalog',transportation:preferences.transportation,preferences,schedule:days});
  plan.preferences=preferences;
  const reopened=parseSavedItinerary(JSON.parse(JSON.stringify(plan)),{days:c.count,currency:c.currency,budget:c.budget,travelers:1,partyType:'solo',startDate:c.start,destination:c.anchor.city});
  assert.deepEqual(reopened.preferences,preferences);assert.equal(verifyGroundedPlan(reopened),true);
  assert.ok(reopened.grounding!.categories.food>=0);assert.ok(reopened.grounding!.unpricedExpenseCount!>=0);
  assert.ok(reopened.days.flatMap(d=>d.activities).filter(a=>a.place).every(a=>a.place!.countryCode===c.anchor.countryCode));
  results.push({destination:c.anchor.city,country:c.anchor.country,style:travelStyle,catalogue:c.places.length,visits:days.map(d=>d.visits.length),day1:plan.days[0].activities.filter(a=>a.place).map(a=>a.place!.name),knownSubtotal:plan.grounding!.total,unpricedExpenses:plan.grounding!.unpricedExpenseCount,firstTimes:days[0].visits.map(v=>v.startMinutes),limitations:plan.grounding!.limitations,diagnostics});
 }
 const reportDirectory=new URL('../../audit/2026-10-14/preference-generation/',import.meta.url);
 if(existsSync(reportDirectory))writeFileSync(new URL('style-replays.json',reportDirectory),JSON.stringify(results,null,2));
});

test('authenticated POST honors selected styles, merges interests and retains accommodation/cache isolation',async t=>{
 clearProviderCache();t.after(clearProviderCache);
 const replace=(object:any,key:string,fn:any)=>{const previous=object[key];object[key]=fn;t.after(()=>object[key]=previous);};
 replace(prisma.user,'findFirst',async()=>({id:'preference-test',name:'Test',email:'test@example.test',role:'traveler',accountStatus:'active',emailVerified:true}));
 replace(prisma,'$queryRaw',async()=>[{count:1}]);
 replace(prisma.listing,'findMany',async()=>[]);
 let generation:any=null, capturedHash='';const hashes:string[]=[];
 replace(prisma.itineraryGeneration,'findUnique',async()=>generation);
 replace(prisma.itineraryGeneration,'create',async(args:any)=>{capturedHash=args.data.requestHash;hashes.push(capturedHash);return {id:'preference-generation',attemptId:'attempt',...args.data};});
 replace(prisma.itineraryGeneration,'updateMany',async()=>({count:1}));
 const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';t.after(()=>{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;});
 const prompts:string[]=[];let failAI=false;
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  if(String(input).includes('api.openai.com')){if(failAI)return Response.json({}, {status:503});const body=JSON.parse(String(init?.body)),prompt=body.messages[1].content;prompts.push(prompt);const [,count,start]=prompt.match(/Plan (\d+) days, starting (\d{4}-\d{2}-\d{2})/);return Response.json({choices:[{message:{content:JSON.stringify({days:Array.from({length:Number(count)},(_,i)=>({day:i+1,date:new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10),theme:'Fixture',visits:[]}))})}}]});}
  return referenceFetcher(destinationReferences[0])(input,init);
 });
 const body={destination:anchor.city,destinationDetails:anchor,latitude:anchor.latitude,longitude:anchor.longitude,startDate:'2040-01-25',endDate:'2040-01-27',budget:10000,currency:'EUR',travelers:1,partyType:'solo',interests:['nature'],preferredActivities:['museum'],accommodationPreference:'resort',transportationPreference:'taxi',plannedAccommodation:{name:'Explicit selected hotel',address:anchor.city,source:'manual'}};
 const headers={cookie:`travelmate_session=${createSessionToken('preference-test','traveler')}`,'content-type':'application/json'};
 for(const travelStyle of [undefined,...travelStyles]){const response=await POST(new Request('http://localhost/api/itinerary',{method:'POST',headers,body:JSON.stringify({...body,travelStyle,pace:'active'})}));assert.equal(response.status,200,JSON.stringify(await response.clone().json()));const plan=await response.json();assert.deepEqual(plan.preferences,{pace:'balanced',travelStyle:travelStyle || 'balanced',accommodation:'resort',transportation:'taxi',activities:['museum'],interests:['nature','museum']});assert.equal(plan.plannedAccommodation.name,'Explicit selected hotel');assert.ok(prompts.at(-1)!.includes(`"travelStyle":"${travelStyle || 'balanced'}"`));assert.ok(plan.grounding.total<10000);}
 assert.equal(new Set(hashes).size,travelStyles.length,'Each selected style must have isolated generation behavior; omission defaults to Balanced');
 for (const empty of [undefined, [], '', null]) {
  const response = await POST(new Request('http://localhost/api/itinerary', { method: 'POST', headers, body: JSON.stringify({ ...body, travelStyle: 'comfort', interests: empty, preferredActivities: empty, transportationPreference: Array.isArray(empty) ? undefined : empty }) }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const generated = await response.json();
  assert.equal(generated.preferences.travelStyle, 'comfort');
  assert.deepEqual(generated.preferences.interests, []);
  assert.deepEqual(generated.preferences.activities, []);
  assert.ok(generated.days.some((day: { activities: Array<{ place?: unknown }> }) => day.activities.some(activity => activity.place)), 'Destination-backed visits must be generated without interests or activities.');
  assert.equal(generated.plannedAccommodation.name, 'Explicit selected hotel');
 }
 failAI=true;const fallback=await POST(new Request('http://localhost/api/itinerary',{method:'POST',headers,body:JSON.stringify({...body,travelStyle:'comfort'})}));assert.equal(fallback.status,200);const plan=await fallback.json();assert.equal(plan.source,'catalog');assert.ok(plan.days.every((d:any)=>d.activities.filter((a:any)=>a.place).length<=3));
 const {createHash}=await import('node:crypto');
 const stable=(v:any):string=>Array.isArray(v)?`[${v.map(stable).join(',')}]`:v&&typeof v==='object'?`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>`${JSON.stringify(k)}:${stable(value)}`).join(',')}}`:JSON.stringify(v);
 generation={id:'legacy-cache',status:'completed',response:{...plan,preferences:{...plan.preferences,travelStyle:'luxury'}},requestHash:createHash('sha256').update(stable(body)).digest('hex'),updatedAt:new Date()};
 const stale=await POST(new Request('http://localhost/api/itinerary',{method:'POST',headers:{...headers,'idempotency-key':'legacy-policy-key'},body:JSON.stringify(body)}));
 assert.equal(stale.status,409,'A response from the previous policy cannot replay as new Balanced output');
 generation=null;
 const changed={...body,travelStyle:'budget'};const started=await beginGeneration('preference-test',anchor.city,changed,'preferences-cache-test');assert.ok('recordId' in started);
 // Record the existing full-body hash, then change each relevant field under the same key.
 generation={id:'cache',status:'completed',response:plan,requestHash:capturedHash,updatedAt:new Date()};
 for(const delta of [{travelStyle:'luxury'},{accommodationPreference:'hostel'},{interests:['food']},{preferredActivities:['park']},{transportationPreference:'walking'},{travelers:2},{budget:9000},{endDate:'2040-01-28'},{plannedAccommodation:{...body.plannedAccommodation,name:'Different hotel'}}])assert.ok('conflict' in await beginGeneration('preference-test',anchor.city,{...changed,...delta},'preferences-cache-test'));
 assert.ok('replay' in await beginGeneration('preference-test',anchor.city,changed,'preferences-cache-test'));
});
