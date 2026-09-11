import { unavailableWeather } from './weather-domain.ts';
import { OpenMeteoWeatherProvider, OpenWeatherMapProvider } from './providers.ts';
import type { WeatherData, WeatherProvider, WeatherRequest } from './types.ts';

export async function resolveWeather(request: WeatherRequest, providers: WeatherProvider[]): Promise<WeatherData> {
  for (const provider of providers) {
    try {
      const weather = await provider.getWeather(request);
      if (weather) return weather;
    } catch (error) {
      console.error(`[TravelMate] ${provider.source} weather provider failed:`, error instanceof Error ? error.message : error);
    }
  }
  return unavailableWeather(request.city);
}

export function configuredWeatherProviders(environment: NodeJS.ProcessEnv = process.env, fetchImplementation: typeof fetch = fetch): WeatherProvider[] {
  const apiKey = environment.OPENWEATHER_API_KEY;
  return [
    ...(apiKey && apiKey !== 'your_openweather_api_key_here' ? [new OpenWeatherMapProvider(apiKey, fetchImplementation)] : []),
    new OpenMeteoWeatherProvider(fetchImplementation),
  ];
}
