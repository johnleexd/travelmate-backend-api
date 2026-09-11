export type WeatherSource = 'openweathermap' | 'open-meteo' | 'unavailable';

export interface ForecastDay {
  date: string;
  tempMin: number;
  tempMax: number;
  description: string;
  icon: string;
  iconUrl: string;
  precipitationProbability: number;
  weatherAlert?: string;
}

export interface WeatherData {
  source: WeatherSource;
  city: string;
  country: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  description: string;
  icon: string;
  iconUrl: string;
  alerts: string[];
  forecast: ForecastDay[];
  forecastAvailable: boolean;
  forecastMessage?: string;
}

export interface WeatherRequest {
  city: string;
  coordinates?: { latitude: number; longitude: number };
}

export interface WeatherProvider {
  readonly source: Exclude<WeatherSource, 'unavailable'>;
  getWeather(request: WeatherRequest): Promise<WeatherData | null>;
}
