import { currentUser } from '../middlewares/auth-middleware.ts';
import { allowRequest } from '../middlewares/rate-limit-middleware.ts';
import { reverseGeocodeLocation } from '../services/destination/location-search-service.ts';

import { searchGlobalLocations } from '../services/destination/global-location-search.ts';
import { resolveDestination } from '../services/destination/location-resolution.ts';
import { selectedAreaParent, searchDestinationAreas } from '../services/destination/destination-areas.ts';
import { compareDestinationAreas } from '../services/destination/area-comparison.ts';

export async function GET(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`locations:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many location searches.' }, { status: 429 });

  const query = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (query.length < 2 || query.length > 100) {
    return Response.json({ error: 'Enter between 2 and 100 characters.' }, { status: 400 });
  }

  try {
    const locations = await searchGlobalLocations(query);
    return Response.json({ locations });
  } catch (error) {
    console.error('[TravelMate] /api/locations unexpected error:', error);
    return Response.json({ error: 'Location search is temporarily unavailable.' }, { status: 502 });
  }
}

export async function GET_CURRENT(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`current-location:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many current-location requests.' }, { status: 429 });

  const params = new URL(request.url).searchParams;
  const latitude = params.get('latitude')?.trim() ? Number(params.get('latitude')) : NaN;
  const longitude = params.get('longitude')?.trim() ? Number(params.get('longitude')) : NaN;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return Response.json({ error: 'Provide valid latitude and longitude coordinates.' }, { status: 400 });
  }

  try {
    const location = await reverseGeocodeLocation(latitude, longitude);
    if (!location) return Response.json({ error: 'Your current area could not be identified. Enter the starting location manually.' }, { status: 404 });
    return Response.json({ location });
  } catch (error) {
    console.error('[TravelMate] Current location lookup failed:', error);
    return Response.json({ error: 'Current location lookup is temporarily unavailable. Enter the starting location manually.' }, { status: 502 });
  }
}

export async function GET_RESOLVE(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`resolve-location:${user.id}`, 20, 60_000)) return Response.json({ error: 'Too many destination resolution requests. Try again shortly.' }, { status: 429 });
  const query = new URL(request.url).searchParams.get('q')?.trim() || '';
  if (query.length < 2 || query.length > 120) return Response.json({ error: 'Enter between 2 and 120 characters, including region and country when possible.' }, { status: 400 });
  try { return Response.json(await resolveDestination(query)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Destination resolution is temporarily unavailable.' }, { status: 502 }); }
}

export async function GET_AREAS(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`destination-areas:${user.id}`, 60, 60_000)) return Response.json({ error: 'Too many area searches. Try again shortly.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const params = new URL(request.url).searchParams;
  const id = Number(params.get('parentId')), countryCode = params.get('countryCode') || '';
  const query = params.get('query')?.trim() || '', offset = Number(params.get('offset') || 0);
  if (!Number.isSafeInteger(id) || !id || !/^[A-Z]{2}$/.test(countryCode) || query.length > 80 || !Number.isInteger(offset) || offset < 0 || offset > 1000) return Response.json({ error: 'Provide a selected area, valid search text and page offset.' }, { status: 400 });
  let parent;
  try { parent = selectedAreaParent(id, countryCode); } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  try { return Response.json(await searchDestinationAreas(parent, query, offset)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Area suggestions are temporarily unavailable.' }, { status: 502, headers: { 'Retry-After': '60' } }); }
}

export async function GET_AREA_COMPARISON(request: Request) {
  const user = await currentUser(request, 'traveler');
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!await allowRequest(`area-comparison:${user.id}`, 10, 60_000)) return Response.json({ error: 'Too many area comparisons. Try again shortly.' }, { status: 429, headers: { 'Retry-After': '60' } });
  const params = new URL(request.url).searchParams;
  const id = Number(params.get('parentId')), countryCode = params.get('countryCode') || '';
  const rawIds = params.get('cityIds') || '';
  if (!Number.isSafeInteger(id) || !id || !/^[A-Z]{2}$/.test(countryCode) || !/^-?\d+(,-?\d+){0,5}$/.test(rawIds)) return Response.json({ error: 'Provide a selected area and one to six city identifiers.' }, { status: 400 });
  const ids = [...new Set(rawIds.split(',').map(Number))];
  let parent;
  try { parent = selectedAreaParent(id, countryCode); } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  try { return Response.json(await compareDestinationAreas(parent, ids)); }
  catch (error) { const message = error instanceof Error ? error.message : 'Area comparison unavailable.'; return Response.json({ error: message }, { status: message.startsWith('Choose up to') ? 400 : 502 }); }
}
