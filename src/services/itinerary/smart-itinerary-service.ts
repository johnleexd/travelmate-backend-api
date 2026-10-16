import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.ts';
import { Prisma, type Trip } from '../../generated/prisma/client.ts';
import { normalizeCurrency, type PublicUser } from '../../schemas/domain.ts';
import { serializeWorkspaceTrip } from '../../repositories/trip-workspace-repository.ts';
import { createItineraryVersion } from '../platform/platform-service.ts';
import { applyManualItineraryChanges } from './itinerary-edit-service.ts';
import { parseSavedItinerary } from './saved-trip-schema.ts';
import { canonical, managedItinerary, recordActivityChange, tripRevision } from './activity-management.ts';
import { activityWindow, availableWindow, clock, generateDayProposal, proposalSchema, replanRequestSchema, remainingActivities, SmartItineraryError, sortDayActivities, validateChangedSchedule, validateDayProposal, type DayProposal, type ReplanRequest, type TravelLeg } from './smart-day-planner.ts';
import { loadGroundedPlaces } from './grounded-places.ts';
import { isDailyBudgetEntry, tripNavigationAnchor, verifiedSavedActivityPlace } from '../navigation/trip-map-service.ts';
import { fetchNavigationRoute, type NavigationRequest } from '../navigation/navigation-service.ts';
import { resolveAIProviders, type AIItineraryProvider } from '../ai/provider.ts';
import { withProviderCache } from '../cache/provider-cache.ts';
import { allowRequest } from '../../middlewares/rate-limit-middleware.ts';
import { constantTimeEqual } from '../../utils/constant-time-equal.ts';
import type { DayActivity, ItineraryResponse } from '../../controllers/itinerary-controller.ts';
export { SmartItineraryError };
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const changesSchema = z.object({ dayIndex:z.number().int().min(0).max(30).optional(), time:z.string().trim().max(30).optional(), title:z.string().trim().min(1).max(160).optional(), description:z.string().max(1000).optional(), location:z.string().trim().max(200).optional(), durationMinutes:z.number().int().min(15).max(720).optional(), estimatedCost:z.number().finite().min(0).max(10000000).optional() }).strict();
export const activityMutationSchema = z.object({ revision, confirm:z.literal(true), action:z.enum(['complete','skip','plan','edit','reschedule']), changes:changesSchema.optional() }).strict().superRefine((value,context)=> {
  if (['edit','reschedule'].includes(value.action) ? !value.changes || !Object.keys(value.changes).length : value.changes !== undefined) context.addIssue({code:'custom',message:'Choose a valid activity change.'});
  if(value.action==='reschedule' && (value.changes?.dayIndex===undefined || !value.changes.time || Object.keys(value.changes).some(key=>!['dayIndex','time','durationMinutes'].includes(key)))) context.addIssue({code:'custom',message:'Rescheduling requires a saved day and time.'});
});
export type ActivityMutation = z.infer<typeof activityMutationSchema>;
export async function readManagedTrip(user: PublicUser, tripId: string) {
  const trip = await prisma.trip.findFirst({ where:{ id:tripId,userId:user.id } });
  if (!trip) throw new SmartItineraryError('Saved trip not found.',404);
  return { trip:{ ...serializeWorkspaceTrip(trip), itinerary:managedItinerary(trip.id,trip.itinerary) }, revision:tripRevision(trip), canManage:trip.status==='active' };
}
function duplicates(plan: ItineraryResponse) {
  const counts = new Map<string,number>();
  for(const activity of plan.days.flatMap(day=>day.activities)) if(activity.status!=='skipped' && !isDailyBudgetEntry(activity)) {
    const key = activity.place?.placeId || (activity.title+'|'+(activity.location||'')).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    counts.set(key,(counts.get(key)||0)+1);
  }
  return counts;
}
function validateNewDuplicates(existing: ItineraryResponse, submitted: ItineraryResponse) {
  const before=duplicates(existing), after=duplicates(submitted);
  for(const [key,count] of after) if(count>1 && count>(before.get(key)||0)) throw new SmartItineraryError('This change would duplicate a saved destination activity.');
}
function validateEditedPlan(trip: Trip, existing: ItineraryResponse, submitted: ItineraryResponse) {
  validateNewDuplicates(existing,submitted);
  const edited=applyManualItineraryChanges(existing,submitted,existing.days.length,Number(trip.budget),trip.travelers,normalizeCurrency(trip.currency)) as unknown as ItineraryResponse;
  return edited;
}
function validateSavedPlan(trip: Trip, plan: ItineraryResponse) {
  return parseSavedItinerary(plan,{ days:Math.round((trip.endDate.getTime()-trip.startDate.getTime())/86400000)+1,currency:normalizeCurrency(trip.currency),budget:Number(trip.budget),travelers:trip.travelers,partyType:trip.partyType,startDate:trip.startDate.toISOString().slice(0,10),destination:trip.destination }) as unknown as ItineraryResponse;
}
export function applyActivityMutation(trip: Trip, activityId: string, input: ActivityMutation) {
  const original=managedItinerary(trip.id,trip.itinerary), plan=structuredClone(original);
  const fromDay=plan.days.findIndex(day=>day.activities.some(activity=>activity.id===activityId));
  if(fromDay<0) throw new SmartItineraryError('Activity not found in this saved trip.',404);
  const activity=plan.days[fromDay].activities.find(activity=>activity.id===activityId)!;
  if(isDailyBudgetEntry(activity)) throw new SmartItineraryError('Daily budget entries can be edited in the saved-trip editor; they are not visits.');
  if(activity.status==='completed' && ['edit','reschedule','skip'].includes(input.action)) throw new SmartItineraryError('Undo completion before editing or rescheduling this activity.');
  if(input.action==='complete' && activity.status==='completed' || input.action==='skip' && activity.status==='skipped' || input.action==='plan' && activity.status==='planned') return original;
  const changes=input.changes || {}, toDay=changes.dayIndex ?? fromDay;
  if(!plan.days[toDay]) throw new SmartItineraryError('Choose a day within this saved trip.');
  if(toDay!==fromDay && input.action!=='reschedule') throw new SmartItineraryError('Use Reschedule to move an activity to another day.');
  if(toDay!==fromDay && plan.days[toDay].activities.length>=8) throw new SmartItineraryError('That day already has 8 activities.');
  const { dayIndex:ignoredDay, ...fields }=changes; void ignoredDay;
  const updated={ ...activity,...fields };
  if(fields.time!==undefined && fields.durationMinutes===undefined && activity.durationMinutes===undefined) { const duration=activityWindow(activity).duration; if(duration!==undefined) updated.durationMinutes=duration; }
  if(input.action==='reschedule' && activityWindow(updated).start===null) throw new SmartItineraryError('Choose an exact destination-local time for rescheduling.');
  if(toDay!==fromDay) { plan.days[fromDay].activities=plan.days[fromDay].activities.filter(item=>item.id!==activityId); plan.days[toDay].activities.push(updated); }
  else plan.days[fromDay].activities=plan.days[fromDay].activities.map(item=>item.id===activityId ? updated : item);
  if(['edit','reschedule'].includes(input.action)) { sortDayActivities(plan,fromDay); sortDayActivities(plan,toDay); }
  let edited=['edit','reschedule'].includes(input.action) ? validateEditedPlan(trip,original,plan) : plan;
  edited.days[toDay].activities=edited.days[toDay].activities.map(item=>item.id===activityId ? { ...item,...recordActivityChange(activity,input.action,original.days[fromDay].date,edited.days[toDay].date,item.time) } : item);
  validateNewDuplicates(original,edited);
  if(input.action==='reschedule') validateChangedSchedule(edited,[fromDay,toDay]);
  if(input.action==='edit' && ('time' in changes || 'durationMinutes' in changes)) validateChangedSchedule(edited,[fromDay,toDay]);
  return validateSavedPlan(trip,edited);
}
async function saveConfirmed(user: PublicUser, tripId: string, expectedRevision: string, action: string, change:(trip:Trip)=>ItineraryResponse) {
  return prisma.$transaction(async transaction=> {
    await transaction.$queryRaw`SELECT "id" FROM "trips" WHERE "id" = ${tripId} AND "user_id" = ${user.id} FOR UPDATE`;
    const existing=await transaction.trip.findFirst({where:{id:tripId,userId:user.id}});
    if(!existing) throw new SmartItineraryError('Saved trip not found.',404);
    if(existing.status!=='active') throw new SmartItineraryError('Reopen this trip before managing its activities.',409);
    if(tripRevision(existing)!==expectedRevision) throw new SmartItineraryError('This trip changed since you opened it. Reload the saved itinerary and review the changes again.',409);
    const itinerary=change(existing);
    if(canonical(itinerary)===canonical(existing.itinerary)) return { trip:serializeWorkspaceTrip(existing),revision:tripRevision(existing),canManage:true };
    const latest=await transaction.itineraryVersion.aggregate({where:{tripId},_max:{version:true}});
    if(!latest._max.version) await createItineraryVersion(transaction,existing,'saved');
    const updated=await transaction.trip.update({where:{id:existing.id},data:{itinerary:itinerary as unknown as Prisma.InputJsonValue}});
    await createItineraryVersion(transaction,updated,'manual_edit');
    await transaction.auditEvent.create({data:{actorId:user.id,action,targetId:tripId}});
    return {trip:serializeWorkspaceTrip(updated),revision:tripRevision(updated),canManage:true};
  });
}
export function mutateManagedActivity(user:PublicUser,tripId:string,activityId:string,input:ActivityMutation) {
  return saveConfirmed(user,tripId,input.revision,'activity-'+input.action,trip=>applyActivityMutation(trip,activityId,input));
}
const signedSchema = z.object({ version:z.literal(1), owner:z.string(),tripId:z.string(),revision,expiresAt:z.number().int(),dayIndex:z.number().int().min(0).max(30),fromTime:z.string(),toTime:z.string(),mode:z.enum(['walking','cycling','driving']),provider:z.enum(['openai','gemini']),proposal:proposalSchema,legs:z.array(z.object({fromId:z.string(),toId:z.string(),minutes:z.number().finite().nonnegative(),source:z.enum(['osrm','estimate'])})).max(8) }).strict();
type SignedProposal=z.infer<typeof signedSchema>;
const secret=()=>process.env.SESSION_SECRET||'travelmate-local-development-secret-change-me';
export function sealDayProposal(value:SignedProposal) { const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return payload+'.'+createHmac('sha256',secret()).update('smart-day-v1:'+payload).digest('base64url'); }
export function openDayProposal(token:string,userId:string,tripId:string,now=Date.now()) {
  try {
    if(token.length>20000) throw new Error();
    const [payload,signature,...extra]=token.split('.');
    if(!payload||!signature||extra.length||!constantTimeEqual(createHmac('sha256',secret()).update('smart-day-v1:'+payload).digest('base64url'),signature)) throw new Error();
    const value=signedSchema.parse(JSON.parse(Buffer.from(payload,'base64url').toString('utf8')));
    if(value.owner!==userId||value.tripId!==tripId||value.expiresAt<=now||value.expiresAt>now+1800000) throw new Error();
    return value;
  } catch { throw new SmartItineraryError('This day preview is invalid or expired. Generate a new preview.',409); }
}
export function applyDayProposal(trip:Trip,input:ReplanRequest,proposal:DayProposal,legs:TravelLeg[]=[]) {
  const original=managedItinerary(trip.id,trip.itinerary),plan=structuredClone(original);
  validateDayProposal(plan,input,proposal,[],legs);
  for(const item of proposal.scheduled) { const activity=plan.days[input.dayIndex].activities.find(activity=>activity.id===item.activityId)!;activity.durationMinutes=activityWindow(activity).duration;activity.time=clock(item.startMinutes); }
  for(const id of proposal.deferred) plan.days[input.dayIndex].activities.find(activity=>activity.id===id)!.time='Flexible';
  sortDayActivities(plan,input.dayIndex);
  const edited=validateEditedPlan(trip,original,plan);
  edited.days[input.dayIndex].activities=edited.days[input.dayIndex].activities.map(activity=> {
    const prior=original.days[input.dayIndex].activities.find(prior=>prior.id===activity.id)!;
    return prior.time!==activity.time ? { ...activity, ...recordActivityChange(prior,'replan',original.days[input.dayIndex].date,original.days[input.dayIndex].date,activity.time) } : activity;
  });
  return validateSavedPlan(trip,edited);
}
export async function previewManagedDay(user:PublicUser,tripId:string,input:ReplanRequest,options:{signal?:AbortSignal;provider?:AIItineraryProvider;route?: (activities:DayActivity[],mode:NavigationRequest['mode'])=>Promise<TravelLeg[]>;catalog?:typeof loadGroundedPlaces}={}) {
  const stored=await prisma.trip.findFirst({where:{id:tripId,userId:user.id}});
  if(!stored) throw new SmartItineraryError('Saved trip not found.',404);
  if(stored.status!=='active') throw new SmartItineraryError('Reopen this trip before replanning.',409);
  if(tripRevision(stored)!==input.revision) throw new SmartItineraryError('This trip changed. Reload before replanning.',409);
  const plan=managedItinerary(tripId,stored.itinerary),remaining=remainingActivities(plan,input.dayIndex);availableWindow(input);
  if(!remaining.length) throw new SmartItineraryError('There are no remaining activities to replan.');
  remaining.forEach(activity=>{if(!activityWindow(activity).duration)throw new SmartItineraryError('Set a saved visit duration for '+activity.title+' before replanning.');});
  const providers=options.provider?[{name:options.provider.name,provider:options.provider}]:resolveAIProviders();
  if(!providers.length) throw new SmartItineraryError('AI replanning is unavailable. Configure the existing OpenAI or Gemini integration on the server; you can still manage activities manually.',503);
  const anchor=tripNavigationAnchor(serializeWorkspaceTrip(stored));
  let references:Awaited<ReturnType<typeof loadGroundedPlaces>>['places']=[];
  if(anchor) try { references=(await (options.catalog||loadGroundedPlaces)(anchor,options.signal)).places; } catch { /* Hours remain explicitly unavailable. */ }
  const route=options.route|| (async (activities,mode)=> {
    if(activities.length<2) return [];
    const places=activities.map(activity=>verifiedSavedActivityPlace(activity,anchor));if(places.some(place=>!place))return [];
    const points=places.map(place=>({latitude:place!.latitude,longitude:place!.longitude}));
    const result=await withProviderCache('trip-day-route:'+JSON.stringify([mode,points]),{source:'activities',freshForMs:300000,staleForMs:300000},()=>fetchNavigationRoute({origin:points[0],destination:points.at(-1)!,mode},{stops:points,reservePublicRequest:()=>allowRequest('navigation-routing:public-provider',1,1100)}));
    return result.value.legDurationsSeconds?.map((seconds,index)=>({fromId:activities[index].id!,toId:activities[index+1].id!,minutes:Math.ceil(seconds/60),source:'osrm' as const}))||[];
  });
  for(const configured of providers) if(configured.provider) {
    try {
      const result=await generateDayProposal(configured.provider!,serializeWorkspaceTrip(stored),plan,input,{references,route,signal:options.signal});
      const expiresAt=Date.now()+900000;
      const signed:SignedProposal={version:1,owner:user.id,tripId,revision:input.revision,expiresAt,dayIndex:input.dayIndex,fromTime:input.fromTime,toTime:input.toTime,mode:input.mode,provider:configured.name,proposal:result.proposal,legs:result.legs};
      const proposed=applyDayProposal(stored,input,result.proposal,result.legs);
      return { token:sealDayProposal(signed),revision:input.revision,expiresAt:new Date(expiresAt).toISOString(),provider:configured.name,dayIndex:input.dayIndex,activities:proposed.days[input.dayIndex].activities,warnings:result.warnings,legs:result.legs };
    } catch(error) { if(error instanceof SmartItineraryError) throw error; }
  }
  throw new SmartItineraryError('The configured AI providers are temporarily unavailable. Your itinerary is unchanged; retry or edit activities manually.',503);
}
export const acceptDaySchema=z.object({ revision,confirm:z.literal(true),token:z.string().min(20).max(20000) }).strict();
export function acceptManagedDay(user:PublicUser,tripId:string,input:z.infer<typeof acceptDaySchema>) {
  const value=openDayProposal(input.token,user.id,tripId);
  if(value.revision!==input.revision) throw new SmartItineraryError('This preview does not match the current saved itinerary.',409);
  return saveConfirmed(user,tripId,value.revision,'accept-day-replan',trip=>applyDayProposal(trip,{revision:value.revision,dayIndex:value.dayIndex,fromTime:value.fromTime,toTime:value.toTime,mode:value.mode},value.proposal,value.legs));
}
