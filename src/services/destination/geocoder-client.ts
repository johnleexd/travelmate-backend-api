let queue: Promise<unknown> = Promise.resolve();
let nextPublicRequestAt = 0;

// One shared queue for explicit resolution and selected-area boundaries. Never
// call the public Nominatim service for typing/autocomplete or town enumeration.
export function fetchGeocoderSearch(params: URLSearchParams, fetcher: typeof fetch = fetch) {
  const endpoint = process.env.DESTINATION_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
  const task = queue.catch(() => {}).then(async () => {
    const publicService = endpoint.startsWith('https://nominatim.openstreetmap.org/');
    if (publicService) {
      const wait = Math.max(0, nextPublicRequestAt - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      nextPublicRequestAt = Date.now() + 1_100;
    }
    const response = await fetcher(`${endpoint}?${params}`, { headers: { Accept: 'application/json', 'User-Agent': 'TravelMate/1.0 (selected destination geography)' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      if (publicService && response.status === 429) {
        const header = response.headers.get('Retry-After');
        const delay = header && /^\d+$/.test(header) ? Number(header) * 1_000 : Math.max(0, Date.parse(header || '') - Date.now());
        nextPublicRequestAt = Math.max(nextPublicRequestAt, Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60_000));
      }
      throw new Error(`Location resolution provider unavailable (${response.status}). Try again or select a suggestion.`);
    }
    return response.json() as Promise<unknown>;
  });
  queue = task;
  return task;
}
