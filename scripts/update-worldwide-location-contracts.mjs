import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../openapi/travelmate-api.json', import.meta.url);
const api = JSON.parse(readFileSync(file, 'utf8')), schemas = api.components.schemas;
const part = { type: 'object', required: ['id','providerId','name','type','countryCode'], properties: { id: { type: 'integer' }, providerId: { type: 'string', maxLength: 100 }, name: { type: 'string', maxLength: 200 }, type: { type: 'string', maxLength: 100 }, countryCode: { type: 'string', pattern: '^[A-Z]{2}$' }, level: { type: 'integer', minimum: 1, maximum: 5 } }, additionalProperties: false };
const properties = { sourceFeatureCode: { type: 'string', maxLength: 10 }, scopeType: { type: 'string', enum: ['country','area','locality','natural'] }, parentId: { type: 'integer' }, canBrowse: { type: 'boolean' }, locationPath: { type: 'array', maxItems: 10, items: part } };
for (const name of ['LocationSuggestion','AdministrativeLocationSuggestion','AreaSuggestion','DestinationAnchor']) { Object.assign(schemas[name].properties, properties); schemas[name].properties.region.maxLength = 1000; }
for (const schema of Object.values(schemas)) { if(schema.properties?.destination?.maxLength === 120) schema.properties.destination.maxLength = 2000; }
schemas.DestinationAnchor.properties.placeType = { type: 'string', maxLength: 100 };
schemas.DestinationAnchor.properties.city.maxLength = 200;
schemas.DestinationAnchor.properties.city.minLength = 1;
Object.assign(schemas.LocationSearchResponse.properties, { total: { type: 'integer', minimum: 0 }, nextOffset: { anyOf: [{type:'integer',minimum:0},{type:'null'}] }, coverage: { type: 'string' }, message: { type: 'string' } });
schemas.DestinationAreasResponse.properties.coverage.enum = ['complete-administrative','partial-geographic','imported-catalogue'];
const search = api.paths['/api/locations']?.get;
if (search) search.parameters ||= [];
if (search && !search.parameters.some(p => p.name === 'offset')) search.parameters.push({ name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Page offset into the full available catalogue; follow nextOffset.' });
const resolve = api.paths['/api/locations/resolve']?.get;
if (resolve) resolve.parameters ||= [];
if (resolve && !resolve.parameters.some(p => p.name === 'secondary')) resolve.parameters.push({ name: 'secondary', in: 'query', schema: { type: 'boolean' }, description: 'Explicit user-triggered verified OpenStreetMap geocoding; never autocomplete.' });
writeFileSync(file, JSON.stringify(api, null, 2) + '\n');
