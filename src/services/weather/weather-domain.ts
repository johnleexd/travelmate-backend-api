import type { ForecastDay, WeatherData } from './types.ts';

export function weatherDetails(code: number): { description: string; icon: string } {
  if (code === 0) return { description: 'clear sky', icon: '01d' };
  if (code <= 2) return { description: 'partly cloudy', icon: '02d' };
  if (code === 3) return { description: 'overcast', icon: '04d' };
  if (code === 45 || code === 48) return { description: 'fog', icon: '50d' };
  if (code >= 51 && code <= 57) return { description: 'drizzle', icon: '09d' };
  if (code >= 61 && code <= 67) return { description: 'rain', icon: '10d' };
  if (code >= 71 && code <= 77) return { description: 'snow', icon: '13d' };
  if (code >= 80 && code <= 82) return { description: 'rain showers', icon: '09d' };
  if (code >= 85 && code <= 86) return { description: 'snow showers', icon: '13d' };
  if (code >= 95) return { description: 'thunderstorm', icon: '11d' };
  return { description: 'variable conditions', icon: '03d' };
}

export function forecastAlert(description: string, rainChance: number, tempMax: number): string | undefined {
  if (description.toLowerCase().includes('thunderstorm')) return 'Thunderstorm risk: move water and outdoor activities indoors.';
  if (rainChance >= 70) return `High rain chance (${rainChance}%): bring rain gear and keep a backup activity.`;
  if (tempMax >= 35) return `Extreme heat (${tempMax}°C): avoid strenuous midday activities.`;
  return undefined;
}

export function currentAlerts(input: { temperature: number; windSpeed: number; humidity: number; condition: string }): string[] {
  const alerts: string[] = [];
  if (input.temperature >= 35) alerts.push(`Extreme heat warning: ${input.temperature}°C. Stay hydrated and avoid midday sun.`);
  if (input.temperature <= 0) alerts.push(`Freezing temperatures: ${input.temperature}°C. Pack heavy winter clothing.`);
  if (input.windSpeed >= 10) alerts.push(`Strong winds: ${input.windSpeed} m/s. Secure loose items when outdoors.`);
  if (input.humidity >= 85) alerts.push(`High humidity: ${input.humidity}%. Expect muggy conditions.`);
  if (input.condition === 'Rain') alerts.push('Rain expected. Pack a compact umbrella.');
  if (input.condition === 'Thunderstorm') alerts.push('Thunderstorm advisory. Avoid open areas.');
  return alerts;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateWeatherDateRange(startDate: string | null, endDate: string | null): { startDate?: string; endDate?: string; error?: string } {
  if (!startDate && !endDate) return {};
  if (!startDate || !endDate || !validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    return { error: 'Provide a valid weather start and end date.' };
  }
  const days = Math.floor((new Date(`${endDate}T00:00:00.000Z`).getTime() - new Date(`${startDate}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;
  if (days > 14) return { error: 'Weather date range cannot exceed 14 days.' };
  return { startDate, endDate };
}

export function weatherForTripDates(weather: WeatherData, startDate?: string, endDate?: string): WeatherData {
  if (weather.source === 'unavailable') return weather;
  if (!startDate || !endDate) return { ...weather, forecastAvailable: weather.forecast.length > 0 };
  const forecast = weather.forecast.filter((day) => day.date >= startDate && day.date <= endDate);
  const requestedDays = Math.floor((new Date(`${endDate}T00:00:00.000Z`).getTime() - new Date(`${startDate}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;
  if (forecast.length === 0) return { ...weather, forecast: [], forecastAvailable: false, forecastMessage: 'Weather forecast is not yet available for these travel dates. Current conditions are shown for reference only.' };
  if (forecast.length < requestedDays) return { ...weather, forecast, forecastAvailable: true, forecastMessage: `Forecast is currently available for ${forecast.length} of ${requestedDays} travel days.` };
  return { ...weather, forecast, forecastAvailable: true, forecastMessage: 'Forecast is available for all selected travel dates.' };
}

export function unavailableWeather(city: string): WeatherData {
  return {
    source: 'unavailable', city, country: '', temperature: 0, feelsLike: 0, humidity: 0, windSpeed: 0,
    description: 'unavailable', icon: '', iconUrl: '', alerts: [], forecast: [], forecastAvailable: false,
    forecastMessage: 'Live weather providers are unavailable. No current conditions or forecast are being claimed for these travel dates.',
  };
}

export function normalizedForecastDay(input: ForecastDay): ForecastDay {
  return {
    ...input,
    tempMin: Math.round(input.tempMin), tempMax: Math.round(input.tempMax),
    precipitationProbability: Math.max(0, Math.min(100, Math.round(input.precipitationProbability))),
  };
}
