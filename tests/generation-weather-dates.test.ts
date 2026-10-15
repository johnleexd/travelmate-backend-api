import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenWeatherMapProvider, OpenMeteoWeatherProvider } from '../src/services/weather/providers.ts';

test('three-hour forecasts match the destination date across UTC midnight instead of scheduling against UTC days', async () => {
  const fetcher: typeof fetch = async input => String(input).includes('/forecast?') ? Response.json({ city: { timezone: 28800 }, list: [{ dt: Date.parse('2040-01-25T18:00:00Z') / 1000, dt_txt: '2040-01-25 18:00:00', main: { temp_min: 26, temp_max: 30 }, pop: 0.9, weather: [{ description: 'thunderstorm', icon: '11d' }] }] }) : Response.json({ name: 'Manila', timezone: 28800, sys: { country: 'PH' }, main: { temp: 27, feels_like: 28, humidity: 80 }, wind: { speed: 2 }, weather: [{ description: 'cloudy', icon: '03d' }] });
  const weather = await new OpenWeatherMapProvider('fixture-only', fetcher).getWeather({ city: 'Manila' });
  assert.equal(weather?.forecast[0].date, '2040-01-26'); assert.match(weather!.forecast[0].weatherAlert!, /Thunderstorm/);
});
test('daily forecast dates use an actual IANA reference through daylight-saving changes; unavailable timezone data stays absent', async () => {
  const current = { name: 'New York City', coord: { lat: 40.71, lon: -74 }, timezone: -18000, sys: { country: 'US' }, main: { temp: 10, feels_like: 9, humidity: 60 }, wind: { speed: 2 }, weather: [{ description: 'cloudy', icon: '03d' }] };
  const fetcher: typeof fetch = async input => String(input).includes('/onecall?') ? Response.json({ timezone: 'America/New_York', timezone_offset: -18000, daily: [{ dt: Date.parse('2040-07-01T04:30:00Z') / 1000, temp: { min: 19, max: 25 }, pop: 0.1, weather: [{ description: 'clear', icon: '01d' }] }] }) : String(input).includes('/forecast?') ? Response.json({ list: [] }) : Response.json(current);
  const weather = await new OpenWeatherMapProvider('fixture-only', fetcher).getWeather({ city: 'New York City' });
  assert.equal(weather?.timeZone, 'America/New_York'); assert.equal(weather?.forecast[0].date, '2040-07-01'); // Summer is UTC-4, not the current offset UTC-5.
  const unavailable: typeof fetch = async input => String(input).includes('/forecast?') ? Response.json({ list: [{ dt_txt: '2040-01-25 18:00:00', main: { temp_min: 10, temp_max: 12 } }] }) : Response.json({ ...current, coord: undefined, timezone: undefined });
  const missing = await new OpenWeatherMapProvider('fixture-only', unavailable).getWeather({ city: 'New York City' });
  assert.equal(missing?.timeZone, undefined); assert.equal(missing?.forecastAvailable, false);
});
test('Open-Meteo retains its destination time-zone reference without synthesizing a zone', async () => {
  const body = { timezone: 'Asia/Manila', current: { temperature_2m: 27, apparent_temperature: 29, relative_humidity_2m: 70, wind_speed_10m: 1, weather_code: 3 }, daily: { time: ['2040-01-25'], weather_code: [3], temperature_2m_max: [30], temperature_2m_min: [26], precipitation_probability_max: [50] } };
  const weather = await new OpenMeteoWeatherProvider(async () => Response.json(body)).getWeather({ city: 'Manila', coordinates: { latitude: 14.6042, longitude: 120.9822 } });
  assert.equal(weather?.timeZone, 'Asia/Manila');
});
