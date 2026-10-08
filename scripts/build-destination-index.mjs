// Rebuild from official GeoNames downloads, without hand-maintained country lists.
import { createReadStream, readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createInflateRaw, gzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { countries } from 'countries-list';

const root = fileURLToPath(new URL('../', import.meta.url));
const archive = root + '.cache/destination-source/allCountries.zip';
const admins = new Map(readFileSync(root + '.cache/destination-source/admin1.txt', 'utf8').split('\n').map(line => { const fields = line.split('\t'); return [fields[0], fields[1]]; }));
const fd = openSync(archive, 'r');
const size = statSync(archive).size;
const tail = Buffer.alloc(Math.min(size, 65557)); readSync(fd, tail, 0, tail.length, size - tail.length);
let end = tail.length - 22;
while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
if (end < 0) throw new Error('Invalid source ZIP directory.');
const directory = Buffer.alloc(tail.readUInt32LE(end + 12));
readSync(fd, directory, 0, directory.length, tail.readUInt32LE(end + 16));
let offset = 0; let entry;
while (offset < directory.length) {
  const nameLength = directory.readUInt16LE(offset + 28), extraLength = directory.readUInt16LE(offset + 30), commentLength = directory.readUInt16LE(offset + 32);
  if (directory.toString('utf8', offset + 46, offset + 46 + nameLength) === 'allCountries.txt') { entry = { length: directory.readUInt32LE(offset + 20), offset: directory.readUInt32LE(offset + 42), method: directory.readUInt16LE(offset + 10) }; break; }
  offset += 46 + nameLength + extraLength + commentLength;
}
if (!entry || entry.method !== 8) throw new Error('Unsupported source ZIP entry.');
const header = Buffer.alloc(30); readSync(fd, header, 0, 30, entry.offset); closeSync(fd);
const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
const lines = createInterface({ input: createReadStream(archive, { start, end: start + entry.length - 1 }).pipe(createInflateRaw()), crlfDelay: Infinity });
const groups = new Map();
let scanned = 0;
for await (const line of lines) {
  scanned++;
  const fields = line.split('\t'); const feature = fields[7], code = fields[8];
  if (!countries[code]) continue;
  const kind = /^(PCLI|PCLD|PCLF|PCLS|PCL)$/.test(feature) ? 'country' : /^(PPLC|PPLA[1-4]?|PPL|PPLL)$/.test(feature) ? 'city' : /^ADM[12]$/.test(feature) ? 'region' : /^(ISL|ISLS|MT|MTS|VLC|PRK|RESN|RESV|BCH|NATF|CNYN|LK)$/.test(feature) ? 'nature' : '';
  if (!kind) continue;
  const latitude = Number(fields[4]), longitude = Number(fields[5]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
  const population = Number(fields[14]) || 0;
  // Population ranks cities; multilingual names provide a modest prominence
  // signal for physical features. These are destinations, not claimed ratings.
  const aliases = fields[3].split(',').filter(Boolean);
  const score = (feature === 'PPLC' ? 100 : feature === 'ADM1' ? 80 : 0) + Math.log10(population + 1) * 10 + Math.log2(aliases.length + 1) * 15;
  const key = code + ':' + kind + (kind === 'nature' ? ':' + feature : ''); const list = groups.get(key) || [];
  const limit = kind === 'city' ? 200 : kind === 'region' ? 30 : kind === 'nature' ? 150 : 3;
  if (list.length >= limit && score <= list.at(-1).score) continue;
  const row = [Number(fields[0]), fields[1], latitude, longitude, feature, code, admins.get(code + '.' + fields[10]) || '', aliases, population];
  list.push({ score, row }); list.sort((a, b) => b.score - a.score || a.row[0] - b.row[0]); list.length = Math.min(limit, list.length); groups.set(key, list);
}
const records = [...groups.values()].flat().sort((a, b) => b.score - a.score || a.row[0] - b.row[0]).map(item => item.row);
// Some supported territory codes have no separate GeoNames ISO country code.
// Resolve them from named island/ADM1 records and their actual administrative
// membership, rather than mixing in the parent territory's other islands.
const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const present = new Set(records.map(row => row[5]));
for (const [code, country] of Object.entries(countries)) {
  if (present.has(code)) continue;
  const names = [country.name, country.native].map(normalize);
  const boundary = records.find(row => /^(ISL|ADM1)$/.test(row[4]) && row[6] && [row[1], ...row[7]].some(name => names.includes(normalize(name))));
  if (!boundary) throw new Error(`No authoritative territory membership found for ${code}.`);
  records.push(...records.filter(row => row[5] === boundary[5] && row[6] === boundary[6]).map(row => { const copy = [...row]; copy[5] = code; return copy; }));
}
mkdirSync(root + 'data', { recursive: true });
writeFileSync(root + 'data/destinations.json.gz', gzipSync(JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'https://download.geonames.org/export/dump/allCountries.zip', records }), { level: 9 }));
console.log(JSON.stringify({ scanned, destinations: records.length, countries: new Set(records.map(row => row[5])).size }));
