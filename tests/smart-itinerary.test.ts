import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import type { Trip } from '../src/generated/prisma/client.ts';
import type { ItineraryResponse } from '../src/controllers/itinerary-controller.ts';
import { parseSavedItinerary } from '../src/services/itinerary/saved-trip-schema.ts';
import { managedItinerary, tripRevision, canonical } from '../src/services/itinerary/activity-management.ts';
import { activityMutationSchema, applyActivityMutation, applyDayProposal, readManagedTrip, previewManagedDay, mutateManagedActivity, acceptManagedDay, openDayProposal, sealDayProposal, acceptDaySchema } from '../src/services/itinerary/smart-itinerary-service.ts';
import { validateDayProposal, generateDayProposal, activityWindow } from '../src/services/itinerary/smart-day-planner.ts';
import { applyManualItineraryChanges } from '../src/services/itinerary/itinerary-edit-service.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
import { GET_ACTIVITIES, PATCH_ACTIVITY, POST_REPLAN, POST_ACCEPT_DAY } from '../src/controllers/smart-itinerary-controller.ts';
import { createSessionToken } from '../src/middlewares/auth-middleware.ts';
const user={ id:'smart-owner',role:'traveler' as const,name:'Test fixture',email:'smart@example.test',emailVerified:true,profileStatus:'unverified' as const,accountStatus:'active' as const,trustScore:50 };
const item=(title:string,time:string,cost:number)=>({title,time,description:'Saved description',estimatedCost:cost,category:'activity' as const,icon:'activity',durationMinutes:60});
function fixture():Trip {
  const plan=parseSavedItinerary({destination:'Manila',totalBudget:20000,currency:'PHP',partyType:'solo',travelers:1,source:'openai',days:[
    {day:1,date:'2040-10-10',theme:'Day one',imageUrl:'',totalCost:400,activities:[item('Museum','09:00',100),item('Park','12:00',0),item('Temple','15:00',200),{title:'Daily meals allowance',time:'Daily allowance',description:'Daily budget',estimatedCost:100,category:'food',icon:'food'}]},
    {day:2,date:'2040-10-11',theme:'Day two',imageUrl:'',totalCost:50,activities:[item('Gallery','11:00',50)]}],
    budgetSummary:{accommodation:0,food:0,activities:0,transport:0,reserve:20000,dailyAverage:10000,total:20000}}, {days:2,currency:'PHP',budget:20000,travelers:1,partyType:'solo',destination:'Manila',startDate:'2040-10-10'});
  return {id:'smart-trip',userId:user.id,destination:'Manila',destinationCity:null,destinationRegion:null,destinationCountry:null,destinationCountryCode:null,latitude:null,longitude:null,budget:20000,currency:'PHP',startDate:new Date('2040-10-10'),endDate:new Date('2040-10-11'),travelers:1,partyType:'solo',interests:[],itinerary:plan,weather:null,status:'active',archivedAt:null,completedAt:null,createdAt:new Date('2026-10-09'),updatedAt:new Date('2026-10-09')} as unknown as Trip;
}
function withPlan(trip:Trip,plan:ItineraryResponse):Trip {return {...trip,itinerary:plan as never};}
function mockStore(t:TestContext,current:Trip) {
  const snapshots:unknown[]=[],events:unknown[]=[],calls:string[]=[]; let updates=0;
  const find=async ({where}:{where:{id:string;userId:string}})=>{calls.push('read');assert.equal(where.id,current.id);return where.userId===user.id?current:null;};
  const tx={trip:{findFirst:find,update:async({data}:{data:{itinerary:unknown}})=>{calls.push('write');updates++;current.itinerary=structuredClone(data.itinerary) as never;current.updatedAt=new Date(current.updatedAt.getTime()+1);return structuredClone(current);}},
    itineraryVersion:{aggregate:async()=>({_max:{version:1+snapshots.length}}),create:async({data}:{data:unknown})=>{snapshots.push(structuredClone(data));return data;}},auditEvent:{create:async({data}:{data:unknown})=>{events.push(data);return data;}},$queryRaw:async()=>{calls.push('lock');return [];}};
  const oldTransaction=prisma.$transaction,oldFind=prisma.trip.findFirst,oldQuery=prisma.$queryRaw;
  Reflect.set(prisma,'$transaction',async(callback:(tx:unknown)=>unknown)=>callback(tx));Reflect.set(prisma.trip,'findFirst',find);Reflect.set(prisma,'$queryRaw',async()=>[{count:1}]);
  t.after(()=>{Reflect.set(prisma,'$transaction',oldTransaction);Reflect.set(prisma.trip,'findFirst',oldFind);Reflect.set(prisma,'$queryRaw',oldQuery);clearProviderCache();});
  return {snapshots,events,calls,updates:()=>updates};
}
after(()=>prisma.$disconnect());
test('legacy activity IDs are stable, unique and read-only until confirmation; revisions ignore object key order',()=>{
  const trip=fixture(),before=canonical(trip),first=managedItinerary(trip.id,trip.itinerary),second=managedItinerary(trip.id,trip.itinerary);
  assert.deepEqual(first,second);assert.equal(new Set(first.days.flatMap(day=>day.activities.map(activity=>activity.id))).size,5);assert.equal(canonical(trip),before);
  assert.equal(tripRevision(trip),tripRevision({...trip,itinerary:Object.fromEntries(Object.entries(trip.itinerary as object).reverse())}));
  assert.notEqual(first.days[0].activities[0].id,managedItinerary('other-trip',trip.itinerary).days[0].activities[0].id);
});
test('completion and skip preserve saved costs, descriptions, IDs and records; completed edits require explicit undo',()=>{
  const trip=fixture(),id=managedItinerary(trip.id,trip.itinerary).days[0].activities[0].id!;
  const completed=applyActivityMutation(trip,id,{revision:tripRevision(trip),confirm:true,action:'complete'}),entry=completed.days[0].activities[0];
  assert.equal(entry.id,id);assert.equal(entry.status,'completed');assert.equal(entry.time,'09:00');assert.equal(entry.estimatedCost,100);assert.equal(entry.managementHistory?.[0].action,'complete');
  assert.throws(()=>applyActivityMutation(withPlan(trip,completed),id,{revision:tripRevision(trip),confirm:true,action:'edit',changes:{time:'10:00'}}),/Undo completion/);
  const planned=applyActivityMutation(withPlan(trip,completed),id,{revision:tripRevision(trip),confirm:true,action:'plan'});assert.equal(planned.days[0].activities[0].managementHistory?.length,2);
  const skipped=applyActivityMutation(withPlan(trip,planned),id,{revision:tripRevision(trip),confirm:true,action:'skip'});assert.equal(skipped.days[0].activities.length,4);assert.equal(skipped.days[0].activities[0].status,'skipped');assert.equal(skipped.days[0].activities[0].estimatedCost,100);
});
test('editing and cross-day rescheduling keep stable identity and persistent history; invalid days, duplicates and overlaps fail',()=>{
  const trip=fixture(),id=managedItinerary(trip.id,trip.itinerary).days[0].activities[1].id!;
  const edited=applyActivityMutation(trip,id,{revision:tripRevision(trip),confirm:true,action:'edit',changes:{title:'Exact park',location:'Named entrance',description:'Changed details',estimatedCost:0}});
  assert.equal(edited.days[0].activities[1].id,id);assert.equal(edited.days[0].activities[1].location,'Named entrance');assert.equal(edited.days[0].activities[1].status,'planned');assert.equal(edited.days[0].activities[1].managementHistory?.[0].action,'edit');
  const moved=applyActivityMutation(withPlan(trip,edited),id,{revision:tripRevision(trip),confirm:true,action:'reschedule',changes:{dayIndex:1,time:'13:00'}});
  assert.equal(moved.days[0].activities.some(item=>item.id===id),false);assert.equal(moved.days[1].activities[1].id,id);assert.equal(moved.days[1].activities[1].status,'rescheduled');assert.equal(moved.days[1].activities[1].managementHistory?.length,2);
  assert.throws(()=>applyActivityMutation(trip,id,{revision:tripRevision(trip),confirm:true,action:'reschedule',changes:{dayIndex:0,time:'09:30'}}),/overlaps/);
  assert.throws(()=>applyActivityMutation(trip,id,{revision:tripRevision(trip),confirm:true,action:'reschedule',changes:{dayIndex:2,time:'13:00'}}),/within this saved trip/);
  assert.throws(()=>applyActivityMutation(trip,id,{revision:tripRevision(trip),confirm:true,action:'edit',changes:{title:'Museum'}}),/duplicate/);
  assert.throws(()=>activityMutationSchema.parse({revision:tripRevision(trip),action:'complete',confirm:false}),/Invalid/);
});
test('existing manual saves preserve server-owned status/history and protect completed/skipped entries from removal',()=>{
  const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary);plan.days[0].activities[0].status='completed';plan.days[0].activities[1].status='skipped';
  const draft=structuredClone(plan);draft.days[0].activities[0].status='planned';
  const saved=applyManualItineraryChanges(plan,draft,2,20000,1,'PHP') as unknown as ItineraryResponse;assert.equal(saved.days[0].activities[0].status,'completed');
  draft.days[0].activities=draft.days[0].activities.filter(activity=>activity.status!=='skipped');assert.throws(()=>applyManualItineraryChanges(plan,draft,2,20000,1,'PHP'),/must remain recorded/);
});
test('AI schedules retain remaining IDs exactly once, preserve fixed completed slots and respect known opening windows',()=>{
  const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary),input={revision:tripRevision(trip),dayIndex:0,fromTime:'08:00',toTime:'18:00',mode:'walking' as const};plan.days[0].activities[0].status='completed';plan.days[0].activities[1].status='skipped';
  const id=plan.days[0].activities[2].id!,proposal={scheduled:[{activityId:id,startMinutes:840}],deferred:[]};assert.deepEqual(validateDayProposal(plan,input,proposal),proposal);
  assert.throws(()=>validateDayProposal(plan,input,{scheduled:[{activityId:id,startMinutes:540}],deferred:[]}),/completed/);
  assert.throws(()=>validateDayProposal(plan,input,{scheduled:proposal.scheduled,deferred:[id]}),/exactly once/);
  assert.throws(()=>validateDayProposal(plan,input,{scheduled:[{activityId:'invented',startMinutes:840}],deferred:[]}),/exactly once/);
  const place={placeId:'Q123',latitude:14.59,longitude:120.97};plan.days[0].activities[2].place=place as never;
  assert.throws(()=>validateDayProposal(plan,input,proposal,[{...place,openingWindows:[{weekdays:[3],startMinutes:600,endMinutes:720}]}] as never),/opening-hours/);
});
test('missing durations stay explicit and actual provider legs are checked without inventing route times',async()=>{
  const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary),ids=plan.days[0].activities.slice(0,3).map(item=>item.id!),input={revision:tripRevision(trip),dayIndex:0,fromTime:'09:00',toTime:'18:00',mode:'driving' as const};
  const proposal={scheduled:[{activityId:ids[0],startMinutes:540},{activityId:ids[1],startMinutes:660}],deferred:[ids[2]]};
  assert.throws(()=>validateDayProposal(plan,input,proposal,[],[{fromId:ids[0],toId:ids[1],minutes:90,source:'osrm'}]),/overlaps/);
  delete plan.days[0].activities[0].durationMinutes;await assert.rejects(generateDayProposal({name:'gemini',generate:async()=>{throw Error('Must not call AI');}},trip,plan,input),/Set a saved visit duration/);
  assert.equal(activityWindow({time:'10:00 AM - 11:00 AM'}).duration,60);
});
test('proposals are expiring, tamper-resistant and bound to owner, trip and revision',()=>{
  const trip=fixture(),value={version:1 as const,owner:user.id,tripId:trip.id,revision:tripRevision(trip),expiresAt:Date.now()+600000,dayIndex:0,fromTime:'09:00',toTime:'18:00',mode:'walking' as const,provider:'gemini' as const,proposal:{scheduled:[],deferred:[]},legs:[]},token=sealDayProposal(value);
  assert.equal(openDayProposal(token,user.id,trip.id).revision,value.revision);
  for(const [owner,id,testToken,now] of [['other',trip.id,token,Date.now()],[user.id,'other',token,Date.now()],[user.id,trip.id,token+'x',Date.now()],[user.id,trip.id,token,value.expiresAt+1]] as const)assert.throws(()=>openDayProposal(testToken,owner,id,now),/invalid or expired/);
  assert.throws(()=>acceptDaySchema.parse({revision:value.revision,token,confirm:false}));
});
test('AI preview never writes; cancel leaves the saved plan intact, and acceptance versions only the confirmed remaining-day changes',async t=>{
  const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary);plan.days[0].activities[0].status='completed';plan.days[0].activities[1].status='skipped';trip.itinerary=plan as never;
  const store=mockStore(t,trip),before=canonical(trip.itinerary),done=structuredClone(plan.days[0].activities[0]),id=plan.days[0].activities[2].id!;let generations=0;
  const provider={name:'gemini' as const,generate:async()=>{generations++;return JSON.stringify({scheduled:[{activityId:id,startMinutes:840}],deferred:[]});}};
  const input={revision:tripRevision(trip),dayIndex:0,fromTime:'13:00',toTime:'18:00',mode:'walking' as const};
  const preview=await previewManagedDay(user,trip.id,input,{provider,route:async()=>[],catalog:async()=>({places:[],status:'unavailable'})});
  assert.equal(store.updates(),0);assert.equal(canonical(trip.itinerary),before);assert.equal(preview.activities.find(item=>item.id===id)?.time,'14:00');assert.match(preview.warnings.join(' '),/Opening hours/);
  await previewManagedDay(user,trip.id,input,{provider,route:async()=>[]});assert.equal(generations,1);assert.equal(store.updates(),0);
  const saved=await acceptManagedDay(user,trip.id,{revision:input.revision,confirm:true,token:preview.token});
  assert.equal(store.updates(),1);assert.deepEqual((saved.trip.itinerary as ItineraryResponse).days[0].activities.find(item=>item.id===done.id),done);
  assert.equal((saved.trip.itinerary as ItineraryResponse).days[0].activities.find(item=>item.id===id)?.status,'rescheduled');assert.equal(store.snapshots.length,1);assert.equal(store.events.length,1);
  await assert.rejects(acceptManagedDay(user,trip.id,{revision:input.revision,confirm:true,token:preview.token}),/changed/);assert.equal(store.updates(),1);
});
test('owned, revision-checked writes persist across fresh reads and create history; foreign, stale and archived edits cannot write',async t=>{
  const trip=fixture(),store=mockStore(t,trip),read=await readManagedTrip(user,trip.id),id=read.trip.itinerary.days[0].activities[0].id!;
  await mutateManagedActivity(user,trip.id,id,{revision:read.revision,confirm:true,action:'complete'});
  const fresh=await readManagedTrip(user,trip.id);assert.equal(fresh.trip.itinerary.days[0].activities[0].status,'completed');assert.equal(fresh.trip.itinerary.days[0].activities[0].managementHistory?.length,1);assert.equal(store.calls.indexOf('lock')<store.calls.indexOf('write'),true);
  await assert.rejects(mutateManagedActivity({...user,id:'foreign'},trip.id,id,{revision:fresh.revision,confirm:true,action:'skip'}),/not found/);
  await assert.rejects(mutateManagedActivity(user,trip.id,id,{revision:read.revision,confirm:true,action:'plan'}),/changed/);trip.status='archived';
  await assert.rejects(mutateManagedActivity(user,trip.id,id,{revision:fresh.revision,confirm:true,action:'plan'}),/Reopen/);assert.equal(store.updates(),1);
});
test('new HTTP endpoints require a signed traveler, enforce ownership and explicit confirmation before provider or write work',async t=>{
  const trip=fixture(),store=mockStore(t,trip);t.mock.method(Math,'random',()=>.5);let providers=0;t.mock.method(globalThis,'fetch',async()=>{providers++;throw Error('No provider for invalid requests');});
  const cookie='travelmate_session='+createSessionToken(user.id,'traveler'),base='http://localhost/api/platform/trips/'+trip.id;
  for(const [handler,path,method,body] of [[GET_ACTIVITIES,'/activities','GET',undefined],[PATCH_ACTIVITY,'/activities/unknown','PATCH',{revision:tripRevision(trip),action:'complete'}],[POST_REPLAN,'/replan','POST',{revision:tripRevision(trip),dayIndex:0,fromTime:'19:00',toTime:'09:00',mode:'walking'}],[POST_ACCEPT_DAY,'/replan/accept','POST',{revision:tripRevision(trip),token:'not-a-valid-signed-token',confirm:true}]] as const){
    const request=(authenticated:boolean)=>new Request(base+path,{method,headers:{...(authenticated?{cookie}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const oldUser=prisma.user.findFirst;Reflect.set(prisma.user,'findFirst',async()=>user);
    try {assert.equal((await handler(request(false))).status,401);const response=await handler(request(true));assert.equal(response.status,handler===GET_ACTIVITIES?200:handler===POST_ACCEPT_DAY?409:400);} finally{Reflect.set(prisma.user,'findFirst',oldUser);}
  }
  assert.equal(providers,0);assert.equal(store.updates(),0);
});

test('changed location drops the old verified pin/photo evidence and cost changes keep sanitized totals',()=>{
  const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary),activity=plan.days[0].activities[1];
  activity.place={provider:'wikidata',placeId:'Q123',name:'Old verified park',city:'Manila',country:'Philippines',countryCode:'PH',latitude:14.59,longitude:120.97,sourceUrl:'https://www.wikidata.org/wiki/Q123',address:'Old address',fetchedAt:'2026-10-09T00:00:00Z',openingHours:'Not available'} as never;
  assert.throws(()=>applyActivityMutation(withPlan(trip,plan),activity.id!,{revision:tripRevision(trip),confirm:true,action:'edit',changes:{estimatedCost:100.004}}),/precision/);
  const changed=applyActivityMutation(withPlan(trip,plan),activity.id!,{revision:tripRevision(trip),confirm:true,action:'edit',changes:{title:'Exact new venue',location:'New exact venue, Manila',description:'Updated',estimatedCost:100}});
  const saved=changed.days[0].activities.find(item=>item.id===activity.id)!;
  assert.equal(saved.place,undefined);assert.equal(saved.estimatedCost,100);assert.equal(saved.location,'New exact venue, Manila');assert.equal(saved.managementHistory?.length,1);
});

test('rescheduling a saved time range retains its actual visit duration without inventing one',()=>{
 const trip=fixture(),plan=managedItinerary(trip.id,trip.itinerary),activity=plan.days[0].activities[1];activity.time='12:00 - 13:30';delete activity.durationMinutes;
 const changed=applyActivityMutation(withPlan(trip,plan),activity.id!,{revision:tripRevision(trip),confirm:true,action:'reschedule',changes:{dayIndex:1,time:'13:00'}});
 const moved=changed.days[1].activities.find(item=>item.id===activity.id)!;assert.equal(moved.durationMinutes,90);assert.equal(moved.time,'13:00');
});
