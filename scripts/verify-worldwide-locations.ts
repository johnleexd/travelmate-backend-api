import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { searchCatalogue, globalCatalogueCoverage, catalogueContains, validateCatalogueSelection } from '../src/services/destination/global-catalogue.ts';
import { searchGlobalLocationsPage } from '../src/services/destination/global-location-search.ts';
import { selectedAreaParent, searchDestinationAreas } from '../src/services/destination/destination-areas.ts';
import { administrativeLocationId, administrativeRecord, administrativeCandidate } from '../src/services/destination/philippine-catalogue.ts';
import { validateDestinationAnchor } from '../src/services/itinerary/grounded-places.ts';
import { tripNavigationAnchor } from '../src/services/navigation/trip-map-service.ts';
import type { Trip } from '../src/generated/prisma/client.ts';
const offline: typeof fetch = async () => { throw Error('Public catalogue verification must not need hotel/photo/private account providers.'); };
const cases = ['Cordova','Cordova, Cebu Philippines','小布施町, 日本','Obuse, Nagano, Japan','하동군, South Korea','Gurye, South Korea','Ubud, Bali, Indonesia','Labuan Bajo, Indonesia','Hana, Hawaii, USA','Springfield, Illinois, United States','Springfield, Oregon, United States','Bled, Slovenia','Èze, France','Rothenburg ob der Tauber, Germany','Lacock, United Kingdom'];
const searches = [];
for (const query of cases) { const start = performance.now(); const page = await searchGlobalLocationsPage(query,0,offline); searches.push({query,total:page.total,nextOffset:page.nextOffset,milliseconds:Math.round(performance.now()-start),locations:page.locations}); }
const cebu = administrativeCandidate(administrativeRecord(administrativeLocationId('0702200000'))!);
const cebuRows = []; let offset: number | null = 0;
while (offset !== null) { const p = await searchDestinationAreas(cebu,'',offset,offline); cebuRows.push(...p.areas); offset = p.nextOffset; }
const cordova = cebuRows.find(p=>p.providerId==='0702220000'); if (!cordova || cebuRows.length!==50 || cebuRows.some(p=>p.provinceCode!=='0702200000')) throw Error('Cebu parent browsing failed.');
const worldwide = searches.filter(s=>s.query!=='Cordova' && !s.query.includes('Philippines')).flatMap(s=>s.locations.slice(0,1));
const roundtrips=[];
for(const p of [cordova,...worldwide]) {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || p.scopeType==='area' || p.scopeType==='country') continue;
  const anchor = {city:p.name,country:p.country,countryCode:p.countryCode,region:p.region,latitude:p.latitude!,longitude:p.longitude!,id:p.id,provider:p.provider,providerId:p.providerId,administrativeCode:p.administrativeCode,provinceCode:p.provinceCode,geographicProvinceCode:p.geographicProvinceCode,administrativeLevel:p.administrativeLevel,coordinateSource:p.coordinateSource,sourceFeatureCode:p.sourceFeatureCode,scopeType:p.scopeType,locationPath:p.locationPath,parentId:p.parentId,canBrowse:p.canBrowse,placeType:p.placeType};
  const canonical = await validateDestinationAnchor(p.label,anchor,p.latitude,p.longitude,offline);
  const stored = JSON.parse(JSON.stringify({destination:p.label,destinationCity:p.name,destinationRegion:p.region,destinationCountry:p.country,destinationCountryCode:p.countryCode,latitude:p.latitude,longitude:p.longitude,itinerary:{grounding:{version:1,destination:canonical}}}));
  const reopened = tripNavigationAnchor(stored as Trip);
  if (reopened?.id!==p.id || reopened.latitude!==p.latitude || reopened.longitude!==p.longitude) throw Error('Stored map anchor changed identity: '+p.label);
  if(p.provider==='geonames') validateCatalogueSelection({id:p.id,countryCode:p.countryCode,providerId:p.providerId,latitude:p.latitude!,longitude:p.longitude!,locationPath:p.locationPath},p.label);
  roundtrips.push({label:p.label,id:p.id,providerId:p.providerId,latitude:p.latitude,longitude:p.longitude,generationValidation:true,accommodationIdentityValidation:true,jsonSaveReopenMapAnchor:true,actualDatabaseSave:false});
}
const d = new DatabaseSync(new URL('../.cache/global-locations/catalogue.sqlite',import.meta.url),{readOnly:true});
const levels = d.prepare('SELECT country,feature,count(*) AS records FROM places GROUP BY country,feature ORDER BY country,feature').all();
const missingParents = d.prepare("SELECT country,feature,count(*) AS records FROM places WHERE parent_id IS NULL AND feature NOT LIKE 'PCL%' GROUP BY country,feature").all();
const japan=selectedAreaParent(1861060,'JP'); const first=await searchDestinationAreas(japan,'',0,offline),second=await searchDestinationAreas(japan,'',20,offline);
if(first.areas.some(a=>second.areas.some(b=>a.id===b.id)))throw Error('Parent pages overlap.');
const result={source:globalCatalogueCoverage(),levels,missingParents,searches,cebu:{total:cebuRows.length,cordova,foreignProvinceRows:0},japanBrowse:{total:first.total,first:first.areas.map(p=>p.id),second:second.areas.map(p=>p.id)},roundtrips,limitations:['Public catalogue queries and production validators run against the full downloaded snapshot. No authenticated shared database write or real hotel quote was performed.','GeoNames populated-place records do not consistently distinguish cities, towns and villages. Missing source hierarchy/type is disclosed.']};
writeFileSync(new URL('../../audit/2026-10-14/worldwide-locations/live-results.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({records:result.source.records,countries:result.source.countries,searches:searches.map(s=>({query:s.query,total:s.total,first:s.locations[0]?.label})),cebu:result.cebu.total,cordova:cordova.providerId,roundtrips:roundtrips.length}));
