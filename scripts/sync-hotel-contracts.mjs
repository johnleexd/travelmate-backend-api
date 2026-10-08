import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { accommodationQuoteSchema, occupancySchema, propertyPhotoSchema } from '../src/services/travel/hotel-quote.ts';
const file = new URL('../openapi/travelmate-api.json', import.meta.url);
const doc = JSON.parse(await readFile(file, 'utf8')), schemas = doc.components.schemas;
const convert = schema => {
  const value = z.toJSONSchema(schema);
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if ('const' in node) { node.enum = [node.const]; delete node.const; }
    Object.values(node).forEach(walk);
  }; walk(value); delete value.$schema; return value;
};
schemas.AccommodationQuote = convert(accommodationQuoteSchema);
schemas.PropertyPhoto = convert(propertyPhotoSchema);
schemas.RoomOccupancy = convert(occupancySchema);
const string = { type: 'string' }, number = { type: 'number' };
schemas.ProviderAccommodation = { type: 'object', required: ['id','propertyId','name','nameSource','address','type','latitude','longitude','distanceKm','amenities','photos','availability'], properties: {
  id: string, propertyId: string, name: string, originalName: string, nameSource: { type: 'string', enum: ['provider-english','transliterated','unavailable'] }, address: string, type: string,
  latitude: number, longitude: number, distanceKm: number, rating: number, amenities: { type: 'array', items: string },
  photos: { type: 'array', items: { $ref: '#/components/schemas/PropertyPhoto' } },
  availability: { type: 'string', enum: ['available','sold-out','unavailable','price-unavailable','provider-error'] },
  environment: {type: 'string', enum: ['sandbox','production']}, providerMessage: string,
  quote: { $ref: '#/components/schemas/AccommodationQuote' }, quoteToken: string,
} };
schemas.AccommodationSearchResponse.properties.providerAccommodations = { type: 'array', items: { $ref: '#/components/schemas/ProviderAccommodation' } };
schemas.AccommodationSearchResponse.properties.providerStatus = { type: 'string', enum: ['not-configured','ready','provider-error','no-results'] };
schemas.AccommodationSearchResponse.properties.providerMessage = string;
schemas.AccommodationSearchResponse.properties.providerEnvironment = {type: 'string', enum: ['sandbox', 'production']};
schemas.LiveAccommodation.properties.originalName = string;
schemas.LiveAccommodation.properties.nameSource = { type: 'string', enum: ['provider-english','transliterated','unavailable'] };
schemas.NearbyAccommodation.properties.originalName = string;
schemas.NearbyAccommodation.properties.nameSource = string;
schemas.AccommodationPlan.properties.providerQuote = { $ref: '#/components/schemas/AccommodationQuote' };
schemas.AccommodationPlan.properties.source.enum = ['travelmate', 'amadeus', 'expedia-rapid', 'liteapi'];
const itinerary = schemas.ItineraryGenerationRequest;
if (itinerary) itinerary.properties.selectedAccommodationQuote = string;
doc.paths['/api/accommodations'].get.parameters ||= [];
doc.paths['/api/accommodations'].get.parameters = doc.paths['/api/accommodations'].get.parameters.filter(p => !['occupancy','guestNationality'].includes(p.name));
doc.paths['/api/accommodations'].get.parameters.push({ name: 'occupancy', in: 'query', schema: { type: 'string' }, description: 'JSON array of exact room adults and childAges (0–17); up to 8 rooms.' });
doc.paths['/api/accommodations'].get.parameters.push({ name: 'guestNationality', in: 'query', schema: {type:'string', pattern:'^[A-Z]{2}$'}, description:'Actual guest nationality (ISO country code), required for LiteAPI rates.' });
doc.paths['/api/accommodations/revalidate'] = { post: { summary: 'Recheck an authenticated traveler recommendation using search only (no reservation)', security: [{ sessionCookie: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['quoteToken','checkInDate','checkOutDate','occupancy'], properties: { quoteToken: string, checkInDate: string, checkOutDate: string, occupancy: convert(occupancySchema) } } } } }, responses: { '200': { description: 'Rechecked accommodation and replacement opaque quote token' }, '409': { description: 'Expired, changed or unavailable quote' }, '502': { description: 'Provider error' } } } };
await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
