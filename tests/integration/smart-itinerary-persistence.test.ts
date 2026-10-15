import assert from 'node:assert/strict';
import test from 'node:test';
// This opt-in test never uses the ordinary application database implicitly.
const isolatedUrl=process.env.TRAVELMATE_ISOLATED_TEST_DATABASE;
test('smart activity history, confirmed replanning and ownership persist in PostgreSQL', {skip:!isolatedUrl?'Set TRAVELMATE_ISOLATED_TEST_DATABASE to a migrated isolated test database.':false},async()=> {
  process.env.DATABASE_URL=isolatedUrl!;
  const {prisma}=await import('../../src/lib/prisma.ts');
  const {publicUser}=await import('../../src/schemas/domain.ts');
  const {parseSavedItinerary}=await import('../../src/services/itinerary/saved-trip-schema.ts');
  const {readManagedTrip,mutateManagedActivity,previewManagedDay,acceptManagedDay}=await import('../../src/services/itinerary/smart-itinerary-service.ts');
  const owner=await prisma.user.create({data:{name:'Isolated smart test',email:'smart-isolated-'+crypto.randomUUID()+'@example.test',role:'traveler',emailVerified:true}});
  let id:string|undefined;
  try {
    const itinerary=parseSavedItinerary({destination:'Isolated test',totalBudget:1000,currency:'PHP',partyType:'solo',travelers:1,source:'openai',days:[{day:1,date:'2040-10-10',theme:'Synthetic fixture',imageUrl:'',totalCost:100,activities:['A','B','C'].map((name,index)=>({title:'Test activity '+name,time:['09:00','11:00','14:00'][index],description:'Synthetic database test, not travel facts.',durationMinutes:60,estimatedCost:index===0?100:0,category:'activity',icon:'map'}))}],budgetSummary:{accommodation:0,food:0,activities:100,transport:0,reserve:900,dailyAverage:100,total:1000}},{days:1,budget:1000,currency:'PHP',travelers:1,partyType:'solo',startDate:'2040-10-10',destination:'Isolated test'});
    const trip=await prisma.trip.create({data:{userId:owner.id,destination:'Isolated test',budget:1000,currency:'PHP',startDate:new Date('2040-10-10'),endDate:new Date('2040-10-10'),travelers:1,partyType:'solo',interests:[],itinerary,status:'active'}});id=trip.id;
    const user=publicUser(owner);let state=await readManagedTrip(user,id);
    const [first,second,third]=state.trip.itinerary.days[0].activities;
    state=await mutateManagedActivity(user,id,first.id!,{revision:state.revision,confirm:true,action:'complete'});
    state=await mutateManagedActivity(user,id,second.id!,{revision:state.revision,confirm:true,action:'skip'});
    state=await mutateManagedActivity(user,id,third.id!,{revision:state.revision,confirm:true,action:'edit',changes:{description:'Persisted user edit'}});
    const completed=structuredClone(state.trip.itinerary.days[0].activities[0]),priorVersions=await prisma.itineraryVersion.count({where:{tripId:id}}),prior=JSON.stringify((await prisma.trip.findUniqueOrThrow({where:{id}})).itinerary);
    const preview=await previewManagedDay(user,id,{revision:state.revision,dayIndex:0,fromTime:'13:00',toTime:'18:00',mode:'walking'},{provider:{name:'gemini',generate:async()=>JSON.stringify({scheduled:[{activityId:third.id,startMinutes:900}],deferred:[]})}});
    assert.equal(JSON.stringify((await prisma.trip.findUniqueOrThrow({where:{id}})).itinerary),prior);assert.equal(await prisma.itineraryVersion.count({where:{tripId:id}}),priorVersions);
    await acceptManagedDay(user,id,{revision:preview.revision,token:preview.token,confirm:true});
    await prisma.$disconnect(); // A fresh connection must see committed state.
    const reread=await readManagedTrip(user,id);assert.deepEqual(reread.trip.itinerary.days[0].activities.find(item=>item.id===first.id),completed);assert.equal(reread.trip.itinerary.days[0].activities.find(item=>item.id===second.id)?.status,'skipped');assert.equal(reread.trip.itinerary.days[0].activities.find(item=>item.id===third.id)?.time,'15:00');assert.equal(reread.trip.itinerary.days[0].activities.find(item=>item.id===third.id)?.description,'Persisted user edit');
    assert.equal(await prisma.itineraryVersion.count({where:{tripId:id}}),priorVersions+1);
    await assert.rejects(readManagedTrip({...user,id:'not-owner'},id),/not found/);await assert.rejects(acceptManagedDay(user,id,{revision:preview.revision,token:preview.token,confirm:true}),/changed since/);
  } finally {
    if(id){await prisma.auditEvent.deleteMany({where:{targetId:id,actorId:owner.id}});await prisma.trip.delete({where:{id,userId:owner.id}});}
    await prisma.user.delete({where:{id:owner.id}});await prisma.$disconnect();
  }
});
