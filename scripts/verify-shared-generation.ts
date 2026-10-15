import fs from 'node:fs';
import pg from 'pg';
import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
loadBackendEnvironment();
if(process.env.TRAVELMATE_ALLOW_ISOLATED_SCHEMA !== '1') throw new Error('Set TRAVELMATE_ALLOW_ISOLATED_SCHEMA=1 to run isolated database verification.');
const databaseUrl=new URL(process.env.DATABASE_URL); if(databaseUrl.hostname.endsWith('.neon.tech')) databaseUrl.hostname=databaseUrl.hostname.replace('-pooler.','.'); const isolatedConnection=databaseUrl.toString();
const schema='travelmate_generation_test_'+Date.now();
const pool=new pg.Pool({connectionString:isolatedConnection,connectionTimeoutMillis:10000,max:1,options:'-c search_path='+schema});
let created=false,client;
try{
 client=await pool.connect();await client.query('CREATE SCHEMA "'+schema+'"');created=true;
 for(const dir of fs.readdirSync('prisma/migrations').filter(name=>fs.existsSync('prisma/migrations/'+name+'/migration.sql')).sort())await client.query(fs.readFileSync('prisma/migrations/'+dir+'/migration.sql','utf8'));
 client.release();client=undefined;
 const {PrismaPg}=await import('@prisma/adapter-pg');const {PrismaClient}=await import('../src/generated/prisma/client.ts');
 const prisma=new PrismaClient({adapter:new PrismaPg({connectionString:isolatedConnection,options:'-c search_path='+schema},{schema})});
 globalThis.travelmatePrisma=prisma;
 const {POST}=await import('../src/controllers/itinerary-controller.ts');const {GET_TRIP}=await import('../src/controllers/platform-controller.ts');
 const {executePlatformAction}=await import('../src/services/platform/platform-service.ts');const {publicUser}=await import('../src/schemas/domain.ts');
 const {createSessionToken}=await import('../src/middlewares/auth-middleware.ts');const {buildTripMapManifest}=await import('../src/services/navigation/trip-map-service.ts');
 const {destinationReferences,referenceFetcher}=await import('../tests/helpers/multi-destination-references.ts');const assert=(await import('node:assert/strict')).default;
 delete process.env.OPENAI_API_KEY;delete process.env.GEMINI_API_KEY;process.env.AI_MOCK_FALLBACK='false';
 const owner=await prisma.user.create({data:{name:'Isolated shared generation tester',email:'shared-generation@example.test',role:'traveler',emailVerified:true}});
 const headers={'content-type':'application/json',cookie:'travelmate_session='+createSessionToken(owner.id,'traveler')};
 const outputs=[];
 for(const reference of destinationReferences){const anchor=reference.anchor;globalThis.fetch=referenceFetcher(reference);
  const body={destination:anchor.city+', '+anchor.country,destinationDetails:anchor,latitude:anchor.latitude,longitude:anchor.longitude,startDate:'2040-01-25',endDate:'2040-01-27',budget:10000,currency:'EUR',travelers:1,partyType:'solo',interests:['culture','nature','food'],travelPace:'balanced'};
  const response=await POST(new Request('http://localhost/api/itinerary',{method:'POST',headers,body:JSON.stringify(body)}));const plan=await response.json();assert.equal(response.status,200,JSON.stringify(plan));
  const saved=await executePlatformAction(publicUser(owner),'save-trip',{...body,itinerary:plan,weather:null});await prisma.$disconnect();
  const reopenResponse=await GET_TRIP(new Request('http://localhost/api/platform/trips/'+saved.id,{headers}));assert.equal(reopenResponse.status,200);const {trip}=await reopenResponse.json();
  assert.deepEqual(trip.itinerary.days,plan.days);assert.equal(trip.itinerary.grounding.total,plan.grounding.total);
  const manifest=buildTripMapManifest(trip);assert.deepEqual(manifest.days.flatMap(d=>d.activities.filter(a=>!a.budgetOnly).map(a=>a.place?.id)),plan.days.flatMap(d=>d.activities.filter(a=>a.place).map(a=>a.place.placeId)));
  assert.equal(await prisma.itineraryVersion.count({where:{tripId:saved.id}}),1);
  outputs.push({anchor,trip,manifest});console.log(JSON.stringify({city:anchor.city,generation:response.status,reopen:reopenResponse.status,visits:manifest.days.map(d=>d.activities.filter(a=>!a.budgetOnly).length),status:plan.days.map(d=>d.planningStatus),total:plan.grounding.total}));
 }
 fs.writeFileSync('../travelmate-frontend-new/e2e/fixtures/shared-destination-schedules.json',JSON.stringify(outputs,null,2));
 await prisma.$disconnect();console.log('Isolated database generation, save and reopen passed for four destinations.');
}catch(error){console.log(JSON.stringify({result:'verification_failed',code:error?.code,reason: String(error?.message??'unknown').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[database address redacted]').slice(0,600)}));process.exitCode=1;}
finally{if(client)client.release();if(created && /^travelmate_generation_test_\d+$/.test(schema)){await pool.query('DROP SCHEMA "'+schema+'" CASCADE');console.log('Removed only the newly created isolated test schema.');}await pool.end();}
