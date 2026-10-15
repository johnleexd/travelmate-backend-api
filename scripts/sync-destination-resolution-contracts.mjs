import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('../openapi/travelmate-api.json', import.meta.url);
const document = JSON.parse(readFileSync(path, 'utf8'));
const schemas = document.components.schemas;
const ref = name => ({ $ref: `#/components/schemas/${name}` });
Object.assign(schemas.LocationSuggestion.properties, {
  provider: { type: 'string', enum: ['geonames','openstreetmap','psgc'] }, providerId: { type:'string' },
  bounds: { type:'object', properties: Object.fromEntries(['south','north','west','east'].map(key => [key,{type:'number'}])), required:['south','north','west','east'] },
});
Object.assign(schemas.NearbyAccommodation.properties, { city:{type:'string'}, countryCode:{type:'string'} });
Object.assign(schemas.AccommodationSearchResponse.properties, {
  status:{type:'string',enum:['ready','no-results','provider-error','needs-area']},
  mapStatus:{type:'string',enum:['ready','no-results','provider-error']},
  quoteStatus:{type:'string',enum:['ready','no-results','provider-error','not-configured']},
  areas:{type:'array',items:ref('LocationSuggestion')},
});
schemas.LocationResolutionResponse = { type:'object', properties:{location:{anyOf:[ref('LocationSuggestion'),{type:'null'}]}, candidates:{type:'array',items:ref('LocationSuggestion')},areas:{type:'array',items:ref('LocationSuggestion')},message:{type:'string'}},required:['location','candidates','areas','message'] };
document.paths['/api/locations/resolve'] = { get:{ tags:['Destination'], summary:'Explicitly resolve a manually entered destination before confirmation', security:[{cookieAuth:[]}], parameters:[{name:'q',in:'query',required:true,schema:{type:'string',minLength:2,maxLength:120}}], responses:{'200':{description:'Validated place, disambiguation candidates and area narrowing suggestions',content:{'application/json':{schema:ref('LocationResolutionResponse')}}},'400':{description:'Invalid query'},'401':{description:'Unauthorized'},'429':{description:'Rate limited'},'502':{description:'Location provider failed; destination remains unconfirmed'}} } };
writeFileSync(path,JSON.stringify(document,null,2)+'\n');
await import('./sync-administrative-location-contracts.mjs');
