import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('data/philippines-psgc-source.json', root), 'utf8'));
const regions = JSON.parse(readFileSync(new URL('data/philippines-psgc-regions.json', root), 'utf8'));
const geocodes = JSON.parse(readFileSync(new URL('.cache/psgc-source/ph-geonames.json', root), 'utf8'));
if (source.provinces.length !== 82 || source.cities.length !== 149 || source.municipalities.length !== 1493 || regions.length !== 18) throw Error('Official source collection is incomplete');
const normal = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const simple = s => normal(s).replace(/^(province|city|municipality) of /, '').replace(/^(province|region) [ivx]+ /, '').replace(/\b(city|province|region|municipality)\b/g, '').replace(/\s+/g,' ').trim();
const byCorrespondence = new Map();
for (const row of geocodes.filter(r => r.featureCode === 'ADM3')) {
  if (!/^\d{9}$/.test(row.admin3Code)) continue;
  const list = byCorrespondence.get(row.admin3Code) || []; list.push(row); byCorrespondence.set(row.admin3Code, list);
}
const provinceMap = new Map(source.provinces.map(p => [p.code, p]));
const records = [
  ...regions.map(r => ({ ...r, level: 'Region', correspondenceCode: null })),
  ...source.provinces.map(r => ({ ...r, level: 'Province' })),
  ...source.cities.map(r => ({ ...r, level: 'City' })),
  ...source.municipalities.map(r => ({ ...r, level: 'Municipality' })),
].map(record => {
  const provinceCode = record.level === 'Province' ? record.code : provinceMap.has(record.code.slice(0,5)+'00000') ? record.code.slice(0,5)+'00000' : null;
  const geographicProvince = provinceCode ? provinceMap.get(provinceCode) : record.correspondenceCode ? source.provinces.find(p => p.correspondenceCode?.slice(0,4) === record.correspondenceCode.slice(0,4)) : undefined;
  let matches;
  if (['City','Municipality'].includes(record.level)) {
    matches = byCorrespondence.get(record.correspondenceCode) || [];
    // Manila's older GeoNames/PSGC representation puts the city correspondence
    // code at ADM2. Accept a populated point only with both exact code and name.
    if (!matches.length && record.correspondenceCode) matches = geocodes.filter(r => /^PPL/.test(r.featureCode) && [r.admin2Code,r.admin3Code].includes(record.correspondenceCode) && [r.name,...r.aliases].some(n=>simple(n)===simple(record.name)));
  }
  else {
    const feature = record.level === 'Province' ? 'ADM2' : 'ADM1';
    matches = geocodes.filter(r => r.featureCode === feature && [r.name, ...r.aliases].some(n => simple(n) === simple(record.name)));
  }
  // Ambiguous/absent geocodes leave an entry unresolved; never invent a point.
  const coordinate = matches.length === 1 && Number.isFinite(matches[0].latitude) && Number.isFinite(matches[0].longitude) ? matches[0] : undefined;
  const cityNames = record.level === 'City' && record.correspondenceCode ? geocodes.filter(r => /^PPL(C|A[2-4]?)$/.test(r.featureCode) && [r.admin2Code,r.admin3Code].includes(record.correspondenceCode) && [r.name,...r.aliases].some(n=>simple(n)===simple(record.name))) : [];
  // Reuse the verified populated-place name (e.g. Cebu City, Manila, Naga),
  // without inventing a City suffix that changes existing attraction lookups.
  const displayName = record.level === 'City' ? cityNames.length === 1 ? cityNames[0].name : record.name.replace(/^City of /,'') : record.name;
  const aliases = new Set(coordinate?.aliases || []);
  if (record.level === 'City') { const short = record.name.replace(/^City of /,'').replace(/ City$/,''); aliases.add(short); aliases.add(short+' City'); }
  if (record.level === 'Province') { aliases.add(record.name+' province'); aliases.add('Province of '+record.name); }
  if (record.code === '1102324000') aliases.add('San Isidro');
  if (record.code === '1004217000') aliases.add('Don Victoriano Chiongbian');
  if (record.code === '0201522000') aliases.add('Sanchez-Mira');
  return { ...record, displayName, regionCode: record.code.slice(0,2)+'00000000', provinceCode, geographicProvinceCode: geographicProvince?.code || null, aliases: [...aliases], ...(coordinate ? { latitude: coordinate.latitude, longitude: coordinate.longitude, geocodingId: coordinate.id, geocodingFeature: coordinate.featureCode, coordinateSource: 'https://www.geonames.org/'+coordinate.id } : {}) };
});
const out = { source: 'Philippine Statistics Authority PSGC public tables', sourceUrls: [...source.sourceUrls, 'https://psa.gov.ph/classification/psgc', 'https://psa.gov.ph/classification/psgc/regions', 'https://psa.gov.ph/classification/psgc/node/1684083211', 'https://psa.gov.ph/classification/psgc/node/1684083815'], tableAsOf: source.tableAsOf, retrievedAt: source.retrievedAt, checkedAgainstRelease: '2026-09-30', license: source.license, coordinateSource: 'https://download.geonames.org/export/dump/allCountries.zip', coordinateSourceRetrievedAt: '2026-10-05', records };
writeFileSync(new URL('data/philippines-administrative.json', root), JSON.stringify(out));
console.log(JSON.stringify({ total: records.length, geocoded: records.filter(r => r.latitude !== undefined).length, unresolved: records.filter(r => r.latitude === undefined).map(r => ({code:r.code,name:r.name,level:r.level})), cebu: records.filter(r => r.provinceCode === '0702200000').length-1 }));
