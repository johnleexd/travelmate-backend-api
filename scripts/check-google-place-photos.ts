import { loadBackendEnvironment } from '../src/config/backend-environment.ts';
import { createGooglePlacePhotoResolver, googlePlacesConfigured } from '../src/services/itinerary/google-place-photos.ts';
loadBackendEnvironment();
if (!googlePlacesConfigured()) { console.log('GOOGLE_PLACES_API_KEY is not configured in the backend environment.'); process.exitCode = 1; }
else {
  const requests: { operation: string; status: number }[] = [];
  const resolver = createGooglePlacePhotoResolver(async (input, init) => {
    try {
      const response = await fetch(input, init);
      requests.push({ operation: String(input).includes('searchText') ? 'text-search' : String(input).includes('/media?') ? 'photo' : 'details', status: response.status });
      return response;
    } catch (error) { console.log(JSON.stringify({ networkError: error instanceof Error ? error.name : 'NetworkError', code: (error as { cause?: { code?: string } }).cause?.code })); throw error; }
  });
  const result = await resolver({ name: 'Jikjisa', city: 'Gimcheon', country: 'South Korea', countryCode: 'KR', latitude: 36.1172, longitude: 128.0084 });
  let imageStatus: number | undefined, imageBytes = 0;
  if (result.photo) {
    const image = await fetch(result.photo.imageUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    imageStatus = image.status; imageBytes = (await image.arrayBuffer()).byteLength;
  }
  console.log(JSON.stringify({ configured: true, requests, matchedPlaceId: result.placeId, photoAvailable: !!result.photo, authorCount: result.photo?.authors.length, sourceLinkPresent: !!result.photo?.googleMapsUri, imageStatus, imageBytes }));
  if (!result.photo || imageStatus !== 200 || !imageBytes) process.exitCode = 1;
}
