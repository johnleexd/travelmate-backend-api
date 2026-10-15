import { readFileSync, writeFileSync } from 'node:fs';
const file = new URL('../openapi/travelmate-api.json', import.meta.url);
const document = JSON.parse(readFileSync(file,'utf8')), s = document.components.schemas;
const metadata = {
  administrativeCode:{type:'string',pattern:'^\\d{10}$'}, provinceCode:{type:'string',pattern:'^\\d{10}$'}, geographicProvinceCode:{type:'string',pattern:'^\\d{10}$'},
  administrativeLevel:{type:'string',enum:['Region','Province','City','Municipality','Barangay']}, coordinateSource:{type:'string',format:'uri'},
};
Object.assign(s.LocationSuggestion.properties, metadata, {provider:{type:'string',enum:['geonames','openstreetmap','psgc']}});
s.AdministrativeLocationSuggestion = {type:'object', properties:{...s.LocationSuggestion.properties, coordinateStatus:{type:'string',enum:['resolved','unresolved']}}, required:s.LocationSuggestion.required.filter(p=>!['latitude','longitude'].includes(p))};
s.LocationSearchResponse.properties.locations.items = {anyOf:[{$ref:'#/components/schemas/LocationSuggestion'},{$ref:'#/components/schemas/AdministrativeLocationSuggestion'}]};
Object.assign(s.AreaSuggestion.properties, s.AdministrativeLocationSuggestion.properties, {membership:{type:'string',enum:['country-code','administrative-hierarchy','boundary','official-administrative','geographic-association']}});
s.AreaSuggestion.required = s.AreaSuggestion.required.filter(p=>!['latitude','longitude'].includes(p));
Object.assign(s.DestinationAreasResponse.properties, {coverage:{type:'string',enum:['complete-administrative','partial-geographic']},catalogueAsOf:{type:'string',format:'date'}});
Object.assign(s.DestinationAnchor.properties, metadata, {id:{type:'integer'},provider:{type:'string',enum:['geonames','openstreetmap','psgc']},providerId:{type:'string'},region:{type:'string'}});
s.PlanGrounding.properties.destination = {$ref:'#/components/schemas/DestinationAnchor'};
const resolve = document.paths['/api/locations/resolve'].get;
resolve.parameters = resolve.parameters.filter(p=>!['locationId','countryCode'].includes(p.name)).map(p=>p.name==='q'?{...p,required:false}:p);
resolve.parameters.push({name:'locationId',in:'query',schema:{type:'integer'}},{name:'countryCode',in:'query',schema:{type:'string',enum:['PH']}});
const accommodations = document.paths['/api/accommodations'].get;
for (const name of ['locationId','locationProvider','locationProviderId','administrativeCode','provinceCode']) {
  accommodations.parameters = accommodations.parameters.filter(p=>p.name!==name);
  accommodations.parameters.push({name,in:'query',schema: name==='locationId'?{type:'integer'}:{type:'string'}});
}
document.paths['/api/locations/areas'].get.parameters.find(p=>p.name==='offset').schema.maximum=100000;
writeFileSync(file,JSON.stringify(document,null,2)+'\n');
