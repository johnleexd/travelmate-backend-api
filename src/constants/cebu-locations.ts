export const CEBU_LOCATIONS = [
  'Cebu City',
  'Mandaue City',
  'Talisay City',
  'Carcar City',
  'Cordova',
  'Sibonga',
  'Madridejos',
] as const;

export type CebuLocation = (typeof CEBU_LOCATIONS)[number];

export const CEBU_COORDINATES: Record<CebuLocation, { latitude: number; longitude: number }> = {
  'Cebu City': { latitude: 10.2934946, longitude: 123.9018183 },
  'Mandaue City': { latitude: 10.3388562, longitude: 123.9545212 },
  'Talisay City': { latitude: 10.2430205, longitude: 123.8488245 },
  'Carcar City': { latitude: 10.1055552, longitude: 123.6406685 },
  Cordova: { latitude: 10.2521909, longitude: 123.9494748 },
  Sibonga: { latitude: 10.0173783, longitude: 123.6204663 },
  Madridejos: { latitude: 11.2962076, longitude: 123.7329261 },
};

export function coordinatesForCebuDestination(value: string): { latitude: number; longitude: number } | null {
  const location = CEBU_LOCATIONS.find((item) => value.toLowerCase().startsWith(item.toLowerCase()));
  return location && /\bcebu\b|\bphilippines\b/i.test(value) ? CEBU_COORDINATES[location] : null;
}

export function isCebuLocation(value: unknown): value is CebuLocation {
  return typeof value === 'string' && CEBU_LOCATIONS.includes(value as CebuLocation);
}

export function formatCebuDestination(location: CebuLocation): string {
  return `${location}, Cebu`;
}
