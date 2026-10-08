export type PolygonGeometry = { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };

export function parsePolygon(value: unknown): PolygonGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as PolygonGeometry;
  if (!['Polygon', 'MultiPolygon'].includes(raw.type) || !Array.isArray(raw.coordinates)) return null;
  const polygons = raw.type === 'Polygon' ? [raw.coordinates] : raw.coordinates;
  let vertices = 0;
  if (!polygons.length || !polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring => {
    if (!Array.isArray(ring) || ring.length < 4) return false;
    vertices += ring.length;
    return ring.every(point => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180 && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90)
      && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1];
  })) || vertices > 500_000) return null;
  return raw;
}

function inRing(longitude: number, latitude: number, ring: number[][]): boolean {
  let x = ring[0][0];
  const unwrapped = ring.map(point => { let lon = point[0]; while (lon - x > 180) lon -= 360; while (lon - x < -180) lon += 360; x = lon; return [lon, point[1]]; });
  while (longitude - unwrapped[0][0] > 180) longitude -= 360;
  while (longitude - unwrapped[0][0] < -180) longitude += 360;
  let inside = false;
  for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
    const [xi, yi] = unwrapped[i], [xj, yj] = unwrapped[j];
    if ((yi > latitude) !== (yj > latitude) && longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeography(latitude: number, longitude: number, geometry: PolygonGeometry): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(polygon => inRing(longitude, latitude, polygon[0]) && !polygon.slice(1).some(hole => inRing(longitude, latitude, hole)));
}
