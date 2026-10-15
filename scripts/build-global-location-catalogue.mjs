// All available countries and current administrative/populated records. No
// population cutoff, city cap, selected-country list or geocoding enumeration.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { archiveLines } from './geonames-archive.mjs';
import { linkFifthLevel } from './link-global-admin5.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'.cache/global-locations');mkdirSync(directory,{recursive:true});
const archive=path.join(root,'.cache/destination-source/allCountries.zip');
if(!existsSync(archive))throw Error('Download the full official GeoNames allCountries.zip into .cache/destination-source/ first.');
const infoFile=path.join(directory,'countryInfo.txt');
if(!existsSync(infoFile)){const r=await fetch('https://download.geonames.org/export/dump/countryInfo.txt',{signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Official country metadata unavailable: '+r.status);writeFileSync(infoFile,await r.text());}
const output=path.join(directory,'catalogue.sqlite'),temporary=output+'.building';
if(existsSync(temporary))throw Error('A previous build file exists. Preserve/inspect it before starting another build.');
const db=new DatabaseSync(temporary);
db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536;
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE countries(code TEXT PRIMARY KEY,name TEXT,id INTEGER,capital TEXT,languages TEXT);
CREATE TABLE places(id INTEGER PRIMARY KEY,name TEXT,feature TEXT,country TEXT,a1 TEXT,a2 TEXT,a3 TEXT,a4 TEXT,latitude REAL,longitude REAL,parent_id INTEGER);
CREATE VIRTUAL TABLE names USING fts5(text,content='',tokenize='unicode61 remove_diacritics 2');
CREATE TABLE admins(key TEXT PRIMARY KEY,id INTEGER UNIQUE,depth INTEGER);
`);
const countryInsert=db.prepare('INSERT INTO countries VALUES(?,?,?,?,?)');
for(const line of readFileSync(infoFile,'utf8').split('\n')){if(!line||line.startsWith('#'))continue;const f=line.split('\t');if(/^[A-Z]{2}$/.test(f[0]))countryInsert.run(f[0],f[4],Number(f[16])||null,f[5],f[15]);}
const insert=db.prepare('INSERT INTO places VALUES(?,?,?,?,?,?,?,?,?,?,NULL)'),fts=db.prepare('INSERT INTO names(rowid,text) VALUES(?,?)');
const countryIds=new Set(db.prepare("SELECT id FROM countries WHERE code NOT IN ('CS','AN')").all().map(c=>c.id));
const normalize=s=>s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
let scanned=0,retained=0,invalid=0;const featureCounts={},countryCounts={};
const countryAliases={};
for(const line of readFileSync(infoFile,'utf8').split('\n')) { if(!line || line.startsWith('#'))continue; const f=line.split('\t'); if(/^[A-Z]{2}$/.test(f[0])) countryAliases[f[0]]=[f[0],f[1],f[4]].filter(Boolean); }
db.exec('BEGIN');
for await(const line of archiveLines(archive,'allCountries.txt')) {
  scanned++;const f=line.split('\t'),feature=f[7],country=f[8];
  const keep=countryIds.has(Number(f[0])) || /^PCL(?!H)/.test(feature) || /^(ADM[1-5]|ADMD)$/.test(feature)||/^PPL/.test(feature)&&!/^PPL(H|W)$/.test(feature);
  if(!keep||!/^[A-Z]{2}$/.test(country))continue;
  const id=Number(f[0]),lat=Number(f[4]),lon=Number(f[5]);if(!Number.isSafeInteger(id)||!f[4]?.trim()||!f[5]?.trim()||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180){invalid++;continue;}
  const aliases=[...new Set(f[3].split(',').filter(Boolean))],name=normalize(f[1]);
  if(/^PCL/.test(feature)||countryIds.has(id)) countryAliases[country]=[...new Set([...(countryAliases[country] || []),f[1],f[2],...aliases])];
  insert.run(id,f[1],feature,country,f[10],f[11],f[12],f[13],lat,lon);
  fts.run(id,[...new Set([name,normalize(f[2]),...aliases.map(normalize)])].join(' | '));
  retained++;featureCounts[feature]=(featureCounts[feature]||0)+1;countryCounts[country]=(countryCounts[country]||0)+1;
  if(retained%50000===0){db.exec('COMMIT;BEGIN');console.log(JSON.stringify({phase:'import',scanned,retained}));}
}
db.exec('COMMIT');console.log(JSON.stringify({phase:'indexing',scanned,retained,invalid}));
db.exec(`CREATE INDEX country_feature ON places(country,feature);
CREATE INDEX administrative_path ON places(country,a1,a2,a3,a4);
INSERT INTO admins SELECT country||'.'||a1||CASE WHEN feature>='ADM2' THEN '.'||a2 ELSE '' END||CASE WHEN feature>='ADM3' THEN '.'||a3 ELSE '' END||CASE WHEN feature>='ADM4' THEN '.'||a4 ELSE '' END,min(id),CAST(substr(feature,4) AS INTEGER) FROM places WHERE feature IN ('ADM1','ADM2','ADM3','ADM4') GROUP BY country,a1,CASE WHEN feature>='ADM2' THEN a2 ELSE '' END,CASE WHEN feature>='ADM3' THEN a3 ELSE '' END,CASE WHEN feature>='ADM4' THEN a4 ELSE '' END HAVING count(*)=1;
`);
// Exact source codes define parentage; never infer it from names or city radii.
const update=db.prepare('UPDATE places SET parent_id=? WHERE id=?');
const admins=new Map(db.prepare('SELECT key,id FROM admins').all().map(r=>[r.key,r.id]));
const countries=new Map(db.prepare('SELECT code,id FROM countries').all().map(r=>[r.code,r.id]));
db.exec('BEGIN');let linked=0;
for(const r of db.prepare('SELECT id,feature,country,a1,a2,a3,a4 FROM places').iterate()){
  if(/^PCL/.test(r.feature)||countryIds.has(r.id))continue;
  const max=/^ADM[1-4]$/.test(r.feature)?Number(r.feature.at(-1))-1:4;
  let parent=countries.get(r.country)||null;
  for(let depth=max;depth>=1;depth--){const codes=[r.country,r.a1,r.a2,r.a3,r.a4].slice(0,depth+1);if(codes.some(c=>!c||c==='00'))continue;const match=admins.get(codes.join('.'));if(match&&match!==r.id){parent=match;break;}}
  update.run(parent,r.id);linked++;if(linked%100000===0){db.exec('COMMIT;BEGIN');console.log(JSON.stringify({phase:'parents',linked}));}
}
db.exec('COMMIT;CREATE INDEX parent_children ON places(parent_id,name);');
const source={version:1,source:'https://download.geonames.org/export/dump/allCountries.zip',countrySource:'https://download.geonames.org/export/dump/countryInfo.txt',license:'CC BY 4.0',builtAt:new Date().toISOString(),archiveModifiedAt:statSync(archive).mtime.toISOString(),scanned,records:retained,invalid,countries:Object.keys(countryCounts).length,countryCounts,featureCounts,notes:['Current ADM1–ADM5/ADMD, populated places, districts and selected natural features; historical/destroyed records excluded.','Complete imported catalogue, not guaranteed complete or accurate worldwide geography.','ADM5 parent uses available ADM1–4 codes; a missing adminCode5 column is disclosed.']};
source.fifthLevel = await linkFifthLevel(db, directory);
db.prepare('INSERT INTO metadata VALUES(?,?)').run('country-aliases',JSON.stringify(countryAliases));
source.notes = ['All available country, ADM1–ADM5/ADMD, populated-place and settlement-section records; historical/destroyed feature codes excluded.', 'Complete imported catalogue, not guaranteed complete or accurate worldwide geography.', 'Parent relationships use exact source codes including the ADM5 supplement; missing or ambiguous source parent codes are not guessed.'];
db.prepare('INSERT INTO metadata VALUES(?,?)').run('source',JSON.stringify(source));db.close();
if(!path.resolve(output).startsWith(path.resolve(directory)+path.sep))throw Error('Catalogue output escaped workspace directory');
renameSync(temporary,output);writeFileSync(path.join(directory,'coverage.json'),JSON.stringify(source,null,2));
console.log(JSON.stringify({phase:'complete',...source,path:output,bytes:statSync(output).size}));
