// Extract geocoding records without the destination catalogue's prominence cap.
import { createReadStream, writeFileSync, openSync, readSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
const root = new URL('../', import.meta.url);
const archive = new URL('.cache/destination-source/allCountries.zip', root);
const fd = openSync(archive, 'r'), size = statSync(archive).size;
const tail = Buffer.alloc(Math.min(size, 65557)); readSync(fd, tail, 0, tail.length, size - tail.length);
let end = tail.length - 22; while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
if (end < 0) throw Error('Invalid GeoNames source archive');
const directory = Buffer.alloc(tail.readUInt32LE(end + 12)); readSync(fd, directory, 0, directory.length, tail.readUInt32LE(end + 16));
let offset = 0, entry;
while (offset < directory.length) {
  const n = directory.readUInt16LE(offset + 28), x = directory.readUInt16LE(offset + 30), c = directory.readUInt16LE(offset + 32);
  if (directory.toString('utf8', offset + 46, offset + 46 + n) === 'allCountries.txt') { entry = { length: directory.readUInt32LE(offset + 20), offset: directory.readUInt32LE(offset + 42), method: directory.readUInt16LE(offset + 10) }; break; }
  offset += 46 + n + x + c;
}
if (!entry || entry.method !== 8) throw Error('Unsupported GeoNames source entry');
const header = Buffer.alloc(30); readSync(fd, header, 0, 30, entry.offset); closeSync(fd);
const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
const lines = createInterface({ input: createReadStream(archive, { start, end: start + entry.length - 1 }).pipe(createInflateRaw()), crlfDelay: Infinity });
const rows = [];
for await (const line of lines) {
  const f = line.split('\t');
  if (f[8] !== 'PH' || !/^(ADM\d|PPL)/.test(f[7])) continue;
  rows.push({ id: Number(f[0]), name: f[1], aliases: f[3].split(',').filter(Boolean), latitude: Number(f[4]), longitude: Number(f[5]), featureCode: f[7], admin1Code: f[10], admin2Code: f[11], admin3Code: f[12], admin4Code: f[13] });
}
mkdirSync(new URL('.cache/psgc-source/', root), { recursive: true });
writeFileSync(new URL('.cache/psgc-source/ph-geonames.json', root), JSON.stringify(rows));
console.log(JSON.stringify({ records: rows.length, cebu: rows.filter(r => /cebu|moalboal|badian|oslob|bantayan|naga/i.test(r.name) && /^ADM/.test(r.featureCode)).slice(0,30) }));
