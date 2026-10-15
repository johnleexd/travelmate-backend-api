import { z } from 'zod';
import { requireUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { isDatabaseConnectionError } from '../lib/database-retry.ts';
import { activityMutationSchema, readManagedTrip, mutateManagedActivity, previewManagedDay, acceptManagedDay, acceptDaySchema, SmartItineraryError } from '../services/itinerary/smart-itinerary-service.ts';
import { replanRequestSchema } from '../services/itinerary/smart-day-planner.ts';
async function context(request:Request,preview=false) {
  const user=await requireUser(request,'traveler');
  if(!await allowRequest((preview?'day-replan:':'activity-manage:')+user.id,preview?3:60,preview?300000:60000)) throw new SmartItineraryError(preview?'Too many replanning requests. Wait a few minutes before trying again.':'Too many activity changes. Try again shortly.',429);
  const parts=new URL(request.url).pathname.split('/').filter(Boolean),tripId=decodeURIComponent(parts[3]||''),activityId=decodeURIComponent(parts[5]||'');
  if(!tripId||tripId.length>100||activityId.length>100) throw new SmartItineraryError('Choose a valid saved trip/activity.');
  return {user,tripId,activityId};
}
function failure(error:unknown) {
  if(isDatabaseConnectionError(error)) throw error;
  const status=error instanceof SmartItineraryError?error.status:error instanceof z.ZodError?400:error instanceof Error&&error.message==='UNAUTHORIZED'?401:400;
  const message=error instanceof SmartItineraryError?error.message:status===401?'Unauthorized.':error instanceof z.ZodError?'Review the activity fields and confirm your changes.': 'The itinerary change could not be validated. Your saved plan is unchanged.';
  return Response.json({error:message},{status,headers:status===429?{'Retry-After':'300'}:undefined});
}
export async function GET_ACTIVITIES(request:Request) { try { const {user,tripId}=await context(request);return Response.json(await readManagedTrip(user,tripId),{headers:{'Cache-Control':'no-store'}}); } catch(error){return failure(error);} }
export async function PATCH_ACTIVITY(request:Request) { try { const {user,tripId,activityId}=await context(request);if(!activityId)throw new SmartItineraryError('Choose a saved activity.');const input=activityMutationSchema.parse(await request.json());return Response.json(await mutateManagedActivity(user,tripId,activityId,input)); } catch(error){return failure(error);} }
export async function POST_REPLAN(request:Request) { try { const {user,tripId}=await context(request,true),input=replanRequestSchema.parse(await request.json());return Response.json(await previewManagedDay(user,tripId,input),{headers:{'Cache-Control':'no-store'}}); } catch(error){return failure(error);} }
export async function POST_ACCEPT_DAY(request:Request) { try { const {user,tripId}=await context(request),input=acceptDaySchema.parse(await request.json());return Response.json(await acceptManagedDay(user,tripId,input)); } catch(error){return failure(error);} }
