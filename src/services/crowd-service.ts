export interface CrowdCondition {
  crowdLevel: 'low' | 'moderate' | 'high';
  crowdSource: 'estimated';
  crowdConfidence: 'low';
  crowdNote: string;
}

export function estimateCrowd(dateText: string, destination: string): CrowdCondition {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  const philippinesDecember = /\b(philippines|cebu)\b/i.test(destination) && date.getUTCMonth() === 11;
  const crowdLevel = weekend && philippinesDecember ? 'high' : weekend || philippinesDecember ? 'moderate' : 'low';
  const factors = [weekend ? 'weekend timing' : 'weekday timing', ...(philippinesDecember ? ['a broad Philippines December-season heuristic'] : [])];
  return {
    crowdLevel,
    crowdSource: 'estimated',
    crowdConfidence: 'low',
    crowdNote: `Low-confidence estimate from ${factors.join(' and ')}; this is not live foot-traffic or venue-capacity data. Check the venue before traveling.`,
  };
}
