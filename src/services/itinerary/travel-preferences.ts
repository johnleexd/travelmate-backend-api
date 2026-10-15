import { z } from 'zod';
import type { GroundedPlace } from './grounded-places.ts';

// Historical styles remain readable; the public generator always uses these defaults.
export const generationDefaults = { travelStyle: 'balanced', pace: 'balanced' } as const;
export const generationPolicyVersion = 'balanced-physical-places-v2';
export const travelStyles = ['budget','balanced','comfort','luxury','family-friendly'] as const;
export const stayPreferences = ['budget-friendly','central location','hostel','condo','resort','family-friendly','luxury','no preference'] as const;
export const generationPreferencesSchema = z.object({
  travelStyle:z.enum(travelStyles).default('balanced'),
  accommodation:z.enum(stayPreferences).default('budget-friendly'),
  transportation:z.string().trim().min(1).max(120).default('practical local transport'),
  activities:z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  interests:z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  pace:z.enum(['relaxed','balanced','active']).default('balanced'),
}).strict();
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
  return `${stylePolicy[prefs.travelStyle].instruction} Travel style is separate from stay preference (${prefs.accommodation}). ${stylePolicy[prefs.travelStyle].meal} Budget is a ceiling, not a spend target. Preserve all known prices and user estimates; leave unavailable prices unpriced. Transport: ${transportPlanning(prefs.transportation).label}; straight-line transfers, real routes and fares need confirmation.`;
}
