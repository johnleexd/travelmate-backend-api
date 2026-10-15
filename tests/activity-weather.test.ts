import assert from 'node:assert/strict';
import test from 'node:test';
import { loadActivityWeather, scheduledMinutes, selectActivityWeather, type HourlyGrid } from '../src/services/navigation/activity-weather.ts';
import { clearProviderCache } from '../src/services/cache/provider-cache.ts';
const epoch = (date: string) => Date.parse(date) / 1000;
const grid = (timezone: string, times: string[]): HourlyGrid => ({ latitude: 14.6, longitude: 121, timezone,
  current: { time: epoch('2026-10-09T02:00:00Z'), temperature_2m: 33, weather_code: 0 },
  hourly: { time: times.map(epoch), temperature_2m: times.map((_,i) => 25+i), weather_code: times.map(() => 2), precipitation_probability: times.map(() => 40) } });
test('scheduled times support AM/PM and 24-hour ranges without guessing vague times', () => {
  assert.equal(scheduledMinutes('9:00 AM – 12:00 PM'), 540); assert.equal(scheduledMinutes('12:30 PM - 2:00 PM'), 750);
  assert.equal(scheduledMinutes('00:15'), 15); assert.equal(scheduledMinutes('18:00 - 20:00'), 1080);
  for (const time of ['Morning', '', '25:00', '13 PM', '09:99']) assert.equal(scheduledMinutes(time), null);
});
test('scheduled forecast uses the place timezone rather than UTC or the browser timezone', () => {
  const weather = selectActivityWeather(grid('Asia/Tokyo', ['2026-10-09T23:00:00Z','2026-10-10T00:00:00Z','2026-10-10T01:00:00Z']), '2026-10-10', '9:15 AM');
  assert.equal(weather.kind, 'forecast'); assert.equal(weather.validAt, '2026-10-10T00:00:00.000Z'); assert.equal(weather.temperature, 26);
  assert.equal(weather.localTime, '2026-10-10T09:00'); assert.equal(weather.precipitationProbability, 40);
});
test('DST-aware Unix conversion uses the future local offset after a clock change', () => {
  const weather = selectActivityWeather(grid('America/New_York', ['2026-11-02T13:00:00Z','2026-11-02T14:00:00Z','2026-11-02T15:00:00Z']), '2026-11-02', '9:00 AM');
  assert.equal(weather.validAt, '2026-11-02T14:00:00.000Z'); assert.equal(weather.localTime, '2026-11-02T09:00');
});
test('far-future and unavailable historical dates never fall back to current conditions', () => {
  const payload = grid('Asia/Manila', ['2026-10-09T00:00:00Z','2026-10-09T01:00:00Z']);
  assert.equal(selectActivityWeather(payload, '2040-01-01', '9 AM').status, 'outside-horizon');
  assert.equal(selectActivityWeather(payload, '2026-10-08', '11:50 PM').status, 'outside-horizon');
  assert.equal(selectActivityWeather(payload, '2026-10-09', 'Morning').status, 'missing-time');
  const current = selectActivityWeather(payload, '2040-01-01', '9 AM', true);
  assert.equal(current.kind, 'current'); assert.equal(current.temperature, 33);
});
test('missing forecast values stay unavailable; missing precipitation remains absent', () => {
  const payload = grid('Asia/Manila', ['2026-10-09T01:00:00Z']); payload.hourly.temperature_2m[0] = null;
  assert.equal(selectActivityWeather(payload, '2026-10-09', '9 AM').status, 'unavailable');
  payload.hourly.temperature_2m[0] = 25; delete payload.hourly.precipitation_probability;
  assert.equal(selectActivityWeather(payload, '2026-10-09', '9 AM').precipitationProbability, undefined);
});
test('nearby activity coordinates reuse cached grid data without fabricated per-pin differences', async () => {
  clearProviderCache(); let calls = 0;
  const fetcher = (async (url: string | URL | Request) => {
    calls++; const params = new URL(String(url)).searchParams;
    assert.equal(params.get('latitude'), '14.601'); assert.equal(params.get('longitude'), '120.981');
    assert.equal(params.get('timezone'), 'auto'); assert.equal(params.get('timeformat'), 'unixtime'); assert.equal(params.get('forecast_days'), '16');
    return Response.json(grid('Asia/Manila', ['2026-10-09T01:00:00Z']));
  }) as typeof fetch;
  const first = await loadActivityWeather({ latitude: 14.601, longitude: 120.981 }, '2026-10-09', '9 AM', false, { fetcher });
  const second = await loadActivityWeather({ latitude: 14.602, longitude: 120.982 }, '2026-10-09', '9 AM', false, { fetcher });
  assert.equal(calls, 1); assert.equal(first.temperature, second.temperature); assert.deepEqual(first.grid, second.grid);
  assert.ok(first.fetchedAt); assert.equal(first.providerUpdatedAt, undefined);
});
test('invalid provider payloads and provider outages show unavailable weather', async () => {
  clearProviderCache();
  assert.equal((await loadActivityWeather({latitude:0,longitude:0},'2026-10-10','9 AM',false,{fetcher:async()=>Response.json({current:{temperature_2m:40}})})).status,'unavailable');
  clearProviderCache();
  assert.equal((await loadActivityWeather({latitude:0,longitude:0},'2026-10-10','9 AM',false,{fetcher:async()=>{throw Error('offline');}})).status,'unavailable');
});

test('old current validity and failed refreshes are visibly stale rather than freshly measured conditions', async t => {
  clearProviderCache(); let now = Date.parse('2026-10-09T02:00:00Z'); t.mock.method(Date, 'now', () => now);
  const point = { latitude: 14.6, longitude: 121 }, payload = grid('Asia/Manila', ['2026-10-09T01:00:00Z']);
  payload.current!.time = epoch('2026-10-09T00:00:00Z');
  const current = await loadActivityWeather(point, '2026-10-09', '9 AM', true, { fetcher: async () => Response.json(payload) });
  assert.equal(current.stale, true); assert.equal(current.kind, 'current');
  now += 20 * 60000;
  const forecast = await loadActivityWeather(point, '2026-10-09', '9 AM', false, { fetcher: async () => { throw Error('offline'); } });
  assert.equal(forecast.status, 'available'); assert.equal(forecast.stale, true);
  now += 60 * 60000;
  assert.equal((await loadActivityWeather(point, '2026-10-09', '9 AM', false, { fetcher: async () => { throw Error('offline'); } })).status, 'unavailable');
});
test('paid weather credentials stay server-side and wrong-location forecasts remain unavailable', async t => {
  clearProviderCache(); const prior = process.env.OPEN_METEO_API_KEY; process.env.OPEN_METEO_API_KEY = 'fixture-only-key';
  t.after(() => { if (prior === undefined) delete process.env.OPEN_METEO_API_KEY; else process.env.OPEN_METEO_API_KEY = prior; });
  const payload = grid('Asia/Manila', ['2026-10-09T01:00:00Z']);
  const result = await loadActivityWeather({ latitude: 14.6, longitude: 121 }, '2026-10-09', '9 AM', false, { fetcher: async url => {
    const parsed = new URL(String(url)); assert.equal(parsed.hostname, 'customer-api.open-meteo.com'); assert.equal(parsed.searchParams.get('apikey'), 'fixture-only-key'); return Response.json(payload);
  } });
  assert.equal(result.status, 'available'); assert.equal(JSON.stringify(result).includes('fixture-only-key'), false);
  clearProviderCache();
  assert.equal((await loadActivityWeather({ latitude: 40, longitude: -70 }, '2026-10-09', '9 AM', false, { fetcher: async () => Response.json(payload) })).status, 'unavailable');
});
test('provider Retry-After prevents repeated requests during weather throttling', async t => {
  clearProviderCache(); let now = Date.now(), calls = 0; t.mock.method(Date, 'now', () => now);
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }); };
  assert.equal((await loadActivityWeather({ latitude: 0, longitude: 0 }, '2026-10-10', '9 AM', false, { fetcher })).status, 'unavailable');
  await loadActivityWeather({ latitude: 1, longitude: 1 }, '2026-10-10', '9 AM', false, { fetcher }); assert.equal(calls, 1);
  now += 121000; await loadActivityWeather({ latitude: 1, longitude: 1 }, '2026-10-10', '9 AM', false, { fetcher }); assert.equal(calls, 2);
});
