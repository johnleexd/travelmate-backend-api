import { coordinatesForCebuDestination } from '../../constants/cebu-locations.ts';
import { currentAlerts, forecastAlert, normalizedForecastDay, weatherDetails } from './weather-domain.ts';
import type { ForecastDay, WeatherData, WeatherProvider, WeatherRequest } from './types.ts';

type FetchImplementation = typeof fetch;
type Place = { name: string; latitude: number; longitude: number; country?: string; country_code?: string; admin1?: string };

export class OpenMeteoWeatherProvider implements WeatherProvider {
  readonly source = 'open-meteo' as const;
  private readonly fetchImplementation: FetchImplementation;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.fetchImplementation = fetchImplementation;
  }

  private async place(request: WeatherRequest): Promise<Place | null> {
    const known = coordinatesForCebuDestination(request.city);
    if (request.coordinates || known) {
      const selected = request.coordinates || known!;
      const parts = request.city.split(',').map((item) => item.trim()).filter(Boolean);
      return { name: parts[0] || request.city, ...selected, country: parts.at(-1), country_code: /philippines|cebu/i.test(request.city) ? 'PH' : undefined, admin1: parts.length > 2 ? parts[1] : undefined };
    }
    const candidates = [...new Set([request.city.trim(), request.city.split(',')[0]?.trim()].filter(Boolean))];
    for (const candidate of candidates) {
      const response = await this.fetchImplementation(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=10&language=en&format=json`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const data = await response.json() as { results?: Place[] };
      const places = data.results || [];
      const selected = /\b(cebu|philippines|ph)\b/i.test(request.city) ? places.find((place) => place.country_code === 'PH') : places[0];
      if (selected) return selected;
    }
    return null;
  }

  async getWeather(request: WeatherRequest): Promise<WeatherData | null> {
    const place = await this.place(request);
    if (!place) return null;
    const dailyFields = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max';
    const currentFields = 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code';
    const response = await this.fetchImplementation(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=${currentFields}&daily=${dailyFields}&wind_speed_unit=ms&timezone=auto&forecast_days=14`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const result = await response.json() as {
      current?: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number };
      daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] };
    };
    if (!result.current || !result.daily || !Array.isArray(result.daily.time)) return null;
    const current = result.current;
    const details = weatherDetails(current.weather_code);
    const forecast = result.daily.time.flatMap((date, index): ForecastDay[] => {
      const tempMin = Number(result.daily!.temperature_2m_min[index]);
      const tempMax = Number(result.daily!.temperature_2m_max[index]);
      const rainChance = Number(result.daily!.precipitation_probability_max[index] || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(tempMin) || !Number.isFinite(tempMax) || !Number.isFinite(rainChance)) return [];
      const dayDetails = weatherDetails(Number(result.daily!.weather_code[index]));
      return [normalizedForecastDay({ date, tempMin, tempMax, description: dayDetails.description, icon: dayDetails.icon, iconUrl: `https://openweathermap.org/img/wn/${dayDetails.icon}@2x.png`, precipitationProbability: rainChance, weatherAlert: forecastAlert(dayDetails.description, rainChance, tempMax) })];
    });
    if (![current.temperature_2m, current.apparent_temperature, current.relative_humidity_2m, current.wind_speed_10m].every(Number.isFinite)) return null;
    const temperature = Math.round(current.temperature_2m);
    const humidity = Math.round(current.relative_humidity_2m);
    const windSpeed = Math.round(current.wind_speed_10m * 10) / 10;
    return {
      source: this.source, city: [place.name, place.admin1].filter(Boolean).join(', '), country: place.country || place.country_code || '',
      temperature, feelsLike: Math.round(current.apparent_temperature), humidity, windSpeed, description: details.description,
      icon: details.icon, iconUrl: `https://openweathermap.org/img/wn/${details.icon}@2x.png`,
      alerts: currentAlerts({ temperature, windSpeed, humidity, condition: details.description === 'thunderstorm' ? 'Thunderstorm' : details.description.includes('rain') ? 'Rain' : '' }),
      forecast, forecastAvailable: forecast.length > 0,
    };
  }
}

interface OpenWeatherCurrent {
  name?: string;
  coord?: { lat: number; lon: number };
  sys?: { country?: string };
  main?: { temp: number; feels_like: number; humidity: number };
  wind?: { speed: number };
  weather?: Array<{ main?: string; description?: string; icon?: string }>;
}

interface ThreeHourEntry {
  dt_txt?: string;
  main?: { temp_min: number; temp_max: number };
  pop?: number;
  weather?: Array<{ description?: string; icon?: string }>;
}

export class OpenWeatherMapProvider implements WeatherProvider {
  readonly source = 'openweathermap' as const;
  private readonly fetchImplementation: FetchImplementation;
  private readonly apiKey: string;

  constructor(apiKey: string, fetchImplementation: FetchImplementation = fetch) {
    this.apiKey = apiKey;
    this.fetchImplementation = fetchImplementation;
  }

  async getWeather(request: WeatherRequest): Promise<WeatherData | null> {
    const query = request.coordinates
      ? `lat=${request.coordinates.latitude}&lon=${request.coordinates.longitude}`
      : `q=${encodeURIComponent(request.city)}`;
    const [currentResponse, forecastResponse] = await Promise.all([
      this.fetchImplementation(`https://api.openweathermap.org/data/2.5/weather?${query}&appid=${this.apiKey}&units=metric`, { signal: AbortSignal.timeout(10_000) }),
      this.fetchImplementation(`https://api.openweathermap.org/data/2.5/forecast?${query}&appid=${this.apiKey}&units=metric&cnt=56`, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!currentResponse.ok) return null;
    const current = await currentResponse.json() as OpenWeatherCurrent;
    if (!current.main || !current.wind || !Array.isArray(current.weather)) return null;
    const rawForecast = forecastResponse.ok ? await forecastResponse.json() as { list?: ThreeHourEntry[] } : undefined;
    const daily = new Map<string, { mins: number[]; maxs: number[]; rain: number[]; description: string; icon: string }>();
    for (const entry of rawForecast?.list || []) {
      const date = entry.dt_txt?.split(' ')[0];
      if (!date || !entry.main) continue;
      const bucket = daily.get(date) || { mins: [], maxs: [], rain: [], description: entry.weather?.[0]?.description || 'variable conditions', icon: entry.weather?.[0]?.icon || '03d' };
      bucket.mins.push(entry.main.temp_min); bucket.maxs.push(entry.main.temp_max); bucket.rain.push((entry.pop || 0) * 100); daily.set(date, bucket);
    }
    let forecast = [...daily.entries()].slice(0, 7).flatMap(([date, bucket]): ForecastDay[] => {
      if (!bucket.mins.length || !bucket.maxs.length) return [];
      const tempMin = Math.min(...bucket.mins); const tempMax = Math.max(...bucket.maxs); const rainChance = Math.max(0, ...bucket.rain);
      return [normalizedForecastDay({ date, tempMin, tempMax, description: bucket.description, icon: bucket.icon, iconUrl: `https://openweathermap.org/img/wn/${bucket.icon}@2x.png`, precipitationProbability: rainChance, weatherAlert: forecastAlert(bucket.description, rainChance, tempMax) })];
    });
    if (current.coord && Number.isFinite(current.coord.lat) && Number.isFinite(current.coord.lon)) {
      try {
        const response = await this.fetchImplementation(`https://api.openweathermap.org/data/3.0/onecall?lat=${current.coord.lat}&lon=${current.coord.lon}&exclude=minutely,hourly&appid=${this.apiKey}&units=metric`, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const result = await response.json() as { daily?: Array<{ dt: number; temp: { min: number; max: number }; pop?: number; weather?: Array<{ description?: string; icon?: string }> }> };
          const dailyForecast = (result.daily || []).slice(0, 7).map((day): ForecastDay => {
            const description = day.weather?.[0]?.description || 'variable conditions'; const icon = day.weather?.[0]?.icon || '03d'; const rainChance = (day.pop || 0) * 100;
            return normalizedForecastDay({ date: new Date(day.dt * 1000).toISOString().slice(0, 10), tempMin: day.temp.min, tempMax: day.temp.max, description, icon, iconUrl: `https://openweathermap.org/img/wn/${icon}@2x.png`, precipitationProbability: rainChance, weatherAlert: forecastAlert(description, rainChance, day.temp.max) });
          });
          if (dailyForecast.length) forecast = dailyForecast;
        }
      } catch { /* Retain the compatible 5-day forecast. */ }
    }
    const temperature = Math.round(current.main.temp); const humidity = Math.round(current.main.humidity); const windSpeed = Math.round(current.wind.speed * 10) / 10;
    const condition = current.weather[0]?.main || '';
    const description = current.weather[0]?.description || 'variable conditions'; const icon = current.weather[0]?.icon || '03d';
    return {
      source: this.source, city: current.name || request.city, country: current.sys?.country || '', temperature,
      feelsLike: Math.round(current.main.feels_like), humidity, windSpeed, description, icon,
      iconUrl: `https://openweathermap.org/img/wn/${icon}@2x.png`, alerts: currentAlerts({ temperature, windSpeed, humidity, condition }),
      forecast, forecastAvailable: forecast.length > 0,
    };
  }
}
