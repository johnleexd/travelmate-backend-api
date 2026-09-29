import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCrowd, estimateCrowdRange } from '../src/services/crowd/crowd-service.ts';
import { OpenMeteoWeatherProvider } from '../src/services/weather/providers.ts';
import { unavailableWeather, validateWeatherDateRange, weatherForTripDates } from '../src/services/weather/weather-domain.ts';
import { resolveWeather } from '../src/services/weather/weather-service.ts';
import type { WeatherData, WeatherProvider } from '../src/services/weather/types.ts';

const weather: WeatherData = {
  source: 'open-meteo', city: 'Cebu City', country: 'Philippines', temperature: 30, feelsLike: 33, humidity: 75, windSpeed: 3,
  description: 'partly cloudy', icon: '02d', iconUrl: 'https://openweathermap.org/img/wn/02d@2x.png', alerts: [], forecastAvailable: true,
  forecast: [
    { date: '2026-10-01', tempMin: 25, tempMax: 31, description: 'rain', icon: '10d', iconUrl: 'https://openweathermap.org/img/wn/10d@2x.png', precipitationProbability: 80 },
    { date: '2026-10-02', tempMin: 24, tempMax: 30, description: 'cloudy', icon: '04d', iconUrl: 'https://openweathermap.org/img/wn/04d@2x.png', precipitationProbability: 30 },
  ],
};

class StubProvider implements WeatherProvider {
  readonly source = 'open-meteo' as const;
  calls = 0;
  private readonly result: WeatherData | null;

  constructor(result: WeatherData | null) { this.result = result; }
  async getWeather(): Promise<WeatherData | null> { this.calls += 1; return this.result; }
}

test('weather date validation rejects malformed and oversized ranges', () => {
  assert.equal(validateWeatherDateRange('2026-10-10', '2026-10-01').error, 'Provide a valid weather start and end date.');
  assert.equal(validateWeatherDateRange('2026-10-01', '2026-10-20').error, 'Weather date range cannot exceed 14 days.');
  assert.deepEqual(validateWeatherDateRange('2026-10-01', '2026-10-02'), { startDate: '2026-10-01', endDate: '2026-10-02' });
});

test('forecast coverage is disclosed for complete, partial, and unavailable dates', () => {
  assert.equal(weatherForTripDates(weather, '2026-10-01', '2026-10-02').forecastMessage, 'Forecast is available for all selected travel dates.');
  const partial = weatherForTripDates(weather, '2026-10-01', '2026-10-03');
  assert.equal(partial.forecast.length, 2);
  assert.match(partial.forecastMessage || '', /2 of 3/);
  const future = weatherForTripDates(weather, '2027-01-01', '2027-01-02');
  assert.equal(future.forecastAvailable, false);
  assert.deepEqual(future.forecast, []);
});

test('weather providers fall through in order and never fabricate final conditions', async () => {
  const unavailable = new StubProvider(null);
  const fallback = new StubProvider(weather);
  assert.equal((await resolveWeather({ city: 'Cebu' }, [unavailable, fallback])).source, 'open-meteo');
  assert.equal(unavailable.calls, 1);
  assert.equal(fallback.calls, 1);
  const result = await resolveWeather({ city: 'Nowhere' }, []);
  assert.deepEqual(result, unavailableWeather('Nowhere'));
  assert.equal(result.source, 'unavailable');
  assert.equal(result.forecastAvailable, false);
});

test('Open-Meteo provider validates and normalizes provider values', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
    current: { temperature_2m: 30.4, apparent_temperature: 34.2, relative_humidity_2m: 86, wind_speed_10m: 4.16, weather_code: 61 },
    daily: { time: ['2026-10-01'], weather_code: [95], temperature_2m_max: [36.2], temperature_2m_min: [25.4], precipitation_probability_max: [120] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const result = await new OpenMeteoWeatherProvider(fakeFetch).getWeather({ city: 'Cebu City, Philippines', coordinates: { latitude: 10.3, longitude: 123.9 } });
  assert.equal(result?.temperature, 30);
  assert.equal(result?.forecast[0].precipitationProbability, 100);
  assert.match(result?.forecast[0].weatherAlert || '', /Thunderstorm/);
  assert.ok((result?.alerts.length || 0) > 0);
});

test('crowd estimates expose low confidence and never claim live foot traffic', () => {
  const retrievedAt = new Date('2026-09-01T00:00:00.000Z');
  const weekday = estimateCrowd('2026-09-10', 'Tokyo, Japan', retrievedAt);
  assert.equal(weekday.crowdLevel, 'low');
  assert.equal(weekday.crowdConfidence, 'low');
  assert.match(weekday.crowdNote, /not live foot-traffic/);
  assert.match(weekday.crowdRecommendation, /No crowd-based timing change/);
  assert.equal(weekday.fetchedAt, retrievedAt.toISOString());
  const peakWeekend = estimateCrowd('2026-12-05', 'Cebu City, Philippines', retrievedAt);
  assert.equal(peakWeekend.crowdLevel, 'high');
  assert.match(peakWeekend.crowdRecommendation, /before 9:00 AM/);
  assert.match(peakWeekend.crowdRecommendation, /No activity was moved automatically/);
  assert.equal(estimateCrowdRange('2026-12-05', '2026-12-07', 'Cebu City, Philippines', retrievedAt).length, 3);
});
