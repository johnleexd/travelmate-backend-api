import { z } from 'zod';
import type { GroundedPlace } from './grounded-places.ts';
import { normalizeInterests, MAX_INTERESTS, MAX_INTEREST_LENGTH } from '../../lib/trip-preferences.ts';

// Defaults apply to deliberate generation, never to reading historical saved plans.
export const generationDefaults = { travelStyle: 'balanced', pace: 'balanced' } as const;
export const generationPolicyVersion = 'trip-length-place-coverage-flexible-v7';
export const travelStyles = ['budget','balanced','comfort','luxury','family-friendly'] as const;
export const stayPreferences = ['budget-friendly','central location','hostel','condo','resort','family-friendly','luxury','no preference'] as const;
export const generationPreferencesSchema = z.object({
  travelStyle:z.enum(travelStyles).default('balanced'),
  accommodation:z.string().trim().min(1).max(120).default('no preference'),
  transportation:z.preprocess(value => value == null || typeof value === 'string' && !value.trim() ? undefined : value,
    z.string().trim().min(1).max(120).default('route confirmation required')),
  activities:z.preprocess(value => value == null || typeof value === 'string' && !value.trim() ? [] : value,
    z.array(z.string().trim().min(1).max(160)).max(20).default([])).transform(values => normalizeInterests(values)),
  interests:z.preprocess(value => value == null ? [] : typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string') ? normalizeInterests(value) : value,
    z.array(z.string().trim().min(1).max(MAX_INTEREST_LENGTH)).max(MAX_INTERESTS).default([])),
  pace:z.enum(['relaxed','balanced','active']).default('balanced'),
}).strict().transform(preferences => ({
  ...preferences, interests: normalizeInterests(preferences.interests, preferences.activities),
})).refine(preferences => preferences.interests.length <= MAX_INTERESTS, `Use at most ${MAX_INTERESTS} interests or activities.`);
export type GenerationPreferences = z.infer<typeof generationPreferencesSchema>;
export type TravelStyle = GenerationPreferences['travelStyle'];
export const stylePolicy = {
  budget:{maxVisits:4,buffer:0,distanceWeight:0.65,meal:'Compare modest local meals and market food against actual menus; prefer suitable lower-cost options, without assuming street food is always cheaper.',instruction:'Prioritize relevant evidenced free or lower-cost visits and compact routes. Unknown admission is not free. Keep explicitly selected transport and accommodation.'},
  balanced:{maxVisits:4,buffer:0,distanceWeight:0.25,meal:'Balance affordable local food, variety and convenience; compare menus and confirm prices.',instruction:'Balance relevant interests, variety, evidenced affordability and convenient routes.'},
  comfort:{maxVisits:2,buffer:15,distanceWeight:0.8,meal:'Prefer conveniently located meals and manageable meal breaks; confirm menus, access and prices.',instruction:'Prioritize compact routes, fewer tiring transfers, manageable visit counts and rest time. Do not replace explicitly selected transportation.'},
  luxury:{maxVisits:2,buffer:15,distanceWeight:0.45,meal:'Consider suitable premium dining only after checking actual menu prices against the remaining budget; otherwise use suitable standard dining.',instruction:'Prioritize suitable source-identified premium opportunities only when known costs fit the spending limit. Expensive does not prove premium quality. Explain unavailable or unaffordable premium options.'},
  'family-friendly':{maxVisits:2,buffer:30,distanceWeight:0.85,meal:'Consider varied, easy-to-access meals and regular breaks for the actual party. Do not assume children, child prices or dietary requirements.',instruction:'Prioritize source-supported parks, museums, aquariums or similar family-suitable opportunities, manageable transfers and breaks. Family-friendly does not mean children are present; age suitability and access need confirmation.'},
} satisfies Record<TravelStyle,{maxVisits:number;buffer:number;distanceWeight:number;meal:string;instruction:string}>;

export { transportPlanning } from './transport-planning.ts';
import { transportPlanning } from './transport-planning.ts';
export function premiumOpportunity(place:GroundedPlace) { return /\b(luxury|premium|spa|opera|fine dining|resort)\b/i.test(`${place.name} ${place.description}`); }
export function familyOpportunity(place:GroundedPlace) { return /\b(park|garden|museum|aquarium|zoo|science|playground)\b/i.test(place.description); }
export function referencedAdmission(place:GroundedPlace,currency?:string) { const fee=place.admission;return fee && (!currency || fee.currency===currency) && Number.isFinite(fee.amount) && fee.amount>=0 ? fee : undefined; }
export function preferenceInstructions(prefs:GenerationPreferences) {
  return `${stylePolicy[prefs.travelStyle].instruction} Travel style sets the overall focus; interests and specific activity requests refine it. Match both against supplied place evidence; a nearby attraction does not prove that a requested activity is offered. Explain unsupported requests and suggest source-supported alternatives. Legacy stay preference: ${prefs.accommodation}; preserve explicitly selected accommodation. ${stylePolicy[prefs.travelStyle].meal} Budget is a ceiling, not a spend target. Preserve all known prices and user estimates; leave unavailable prices unpriced. Transport scheduling: ${transportPlanning(prefs.transportation).label}; internal buffers are not provider travel times. Next-stop guidance is supplied separately from routing data. Do not invent travel modes, routes, stops, schedules, fares, taxi or motorcycle availability. Real routes and local transport need confirmation.`;
}
