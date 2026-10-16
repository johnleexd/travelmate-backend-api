/** Selection scope is independent of whether a place has recorded children.
 * Source-supplied scope takes precedence over legacy display terminology. */
type LocationScope = { scopeType?: 'country' | 'area' | 'locality' | 'natural'; placeType: string };
export function needsDestinationArea(location: LocationScope): boolean {
  if (location.scopeType === 'locality') return false;
  if (location.scopeType === 'country' || location.scopeType === 'area') return true;
  return ['Country', 'Region', 'Province', 'Island', 'Administrative area'].includes(location.placeType);
}
export function isDestinationLocality(location: LocationScope): boolean {
  if (location.scopeType) return location.scopeType === 'locality';
  return /^(city|capital city|administrative capital|locality|municipality|town|township|village|hamlet|commune|independent city)\b/i.test(location.placeType);
}
