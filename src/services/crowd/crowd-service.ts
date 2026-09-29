/** Deterministic crowd estimation used when no live crowd provider is available. */
export interface CrowdCondition {
  date: string;
  crowdLevel: 'low' | 'moderate' | 'high';
  crowdSource: 'estimated';
  crowdConfidence: 'low';
  crowdNote: string;
  crowdRecommendation: string;
  fetchedAt: string;
  refreshAfter: string;
}

export function estimateCrowd(dateText: string, destination: string, retrievedAt = new Date()): CrowdCondition {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const philippinesDecember = /\b(philippines|cebu)\b/i.test(destination) && date.getUTCMonth() === 11;
  const crowdLevel = weekend && philippinesDecember ? 'high' : weekend || philippinesDecember ? 'moderate' : 'low';
  const factors = [weekend ? 'weekend timing' : 'weekday timing', ...(philippinesDecember ? ['a broad Philippines December-season heuristic'] : [])];
  const crowdRecommendation = crowdLevel === 'high'
    ? 'Consider visiting the busiest attraction before 9:00 AM or keep a nearby alternative. No activity was moved automatically.'
    : crowdLevel === 'moderate'
      ? 'Prefer an earlier arrival for major attractions and confirm venue hours. No activity was moved automatically.'
      : 'No crowd-based timing change is suggested, but confirm venue hours before traveling.';
  return {
    date: dateText,
    crowdLevel,
    crowdSource: 'estimated',
    crowdConfidence: 'low',
    crowdNote: `Low-confidence estimate from ${factors.join(' and ')}; this is not live foot-traffic or venue-capacity data. Check the venue before traveling.`,
    crowdRecommendation,
    fetchedAt: retrievedAt.toISOString(),
    refreshAfter: new Date(retrievedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function estimateCrowdRange(startDate: string | undefined, endDate: string | undefined, destination: string, retrievedAt = new Date()): CrowdCondition[] {
  if (!startDate || !endDate) return [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const result: CrowdCondition[] = [];
  for (let cursor = start; cursor <= end && result.length < 14; cursor = new Date(cursor.getTime() + 86_400_000)) {
    result.push(estimateCrowd(cursor.toISOString().slice(0, 10), destination, retrievedAt));
  }
  return result;
}
