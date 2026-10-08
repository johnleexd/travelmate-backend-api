import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { destinationAnchorSchema, priceEvidenceSchema, placeEvidenceSchema, groundingSchema } from '../src/services/itinerary/grounding-schema.ts';

const path = new URL('../openapi/travelmate-api.json', import.meta.url);
const document = JSON.parse(readFileSync(path, 'utf8'));
const schemas = document.components.schemas;
for (const [name, schema] of Object.entries({ DestinationAnchor: destinationAnchorSchema, PriceEvidence: priceEvidenceSchema, PlaceEvidence: placeEvidenceSchema, PlanGrounding: groundingSchema })) {
  const { $schema, ...json } = z.toJSONSchema(schema, { target: 'draft-7' });
  schemas[name] = json;
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
Object.assign(schemas.DayActivity.properties, { priceEvidence: ref('PriceEvidence'), place: ref('PlaceEvidence') });
Object.assign(schemas.ItineraryResponse.properties, { grounding: ref('PlanGrounding'), groundingProof: { type: 'string' } });
schemas.AccommodationPlan.properties.fetchedAt = { type: 'string', format: 'date-time' };
schemas.AccommodationPlan.properties.rooms = { type: 'integer', minimum: 1, maximum: 20 };
for (const name of ['SelectedFlightCost', 'SelectedActivityCost']) Object.assign(schemas[name].properties, { isLive: { type: 'boolean' }, source: { type: 'string', enum: ['amadeus'] } });
Object.assign(schemas.ItineraryGenerationRequest.properties, {
  destinationDetails: ref('DestinationAnchor'), startingLocation: { type: 'string', minLength: 2, maxLength: 200 },
  rooms: { type: 'integer', minimum: 1, maximum: 20 }, foodDailyPerPerson: { type: 'number', minimum: 0 },
  nightlyRoomEstimate: { type: 'number', minimum: 0 }, transportFare: { type: 'number', minimum: 0 }, transportFareType: { type: 'string', enum: ['shared-fare', 'per-person'] }, fees: { type: 'number', minimum: 0 }, contingencyPercent: { type: 'number', minimum: 0, maximum: 50 },
});
Object.assign(schemas.ItineraryGenerationRequest.properties, {
  latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 },
  externalAccommodation: { type: 'object', properties: { ...schemas.LiveAccommodation.properties }, required: ['hotelId','offerId','name','nightlyRate','total','currency','isLive','fetchedAt','selectionToken'] },
  selectedFlight: { type: 'object', properties: { id: { type:'string' }, name: { type:'string' }, price: { type:'number',minimum:0 }, currency: ref('CurrencyCode'), fetchedAt: { type:'string',format:'date-time' }, isLive: { type:'boolean' }, selectionToken: { type:'string' } }, required:['id','name','price','currency','fetchedAt','selectionToken'] },
});
schemas.ItineraryGenerationRequest.properties.selectedActivities = { type:'array', maxItems:10, items: schemas.ItineraryGenerationRequest.properties.selectedFlight };
const photoRequest = document.paths['/api/itinerary/images']?.post?.requestBody?.content?.['application/json']?.schema;
if (photoRequest?.properties) photoRequest.properties.itinerary = ref('ItineraryResponse');
schemas.SelectedActivityCost.properties.source = { type: 'string', enum: ['amadeus', 'travelmate'] };
schemas.SelectedActivityCost.properties.priceBasis = { type: 'string', enum: ['per-person-assumption'] };
schemas.ItineraryDayResponse.properties.groundingProof = { type: 'string' };
schemas.ItineraryGenerationRequest.required = [...new Set([...schemas.ItineraryGenerationRequest.required.filter((field: string) => field !== 'startingLocation'), 'destinationDetails', 'latitude', 'longitude'])];
writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
