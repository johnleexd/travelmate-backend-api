import { archiveLines } from './geonames-archive.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export async function linkFifthLevel(db, directory) {
  const archive = path.join(directory, 'adminCode5.zip');
  if (!existsSync(archive)) { const response = await fetch('https://download.geonames.org/export/dump/adminCode5.zip', { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw Error('ADM5 supplementary source unavailable: ' + response.status); writeFileSync(archive, new Uint8Array(await response.arrayBuffer())); }
  db.exec('CREATE TABLE IF NOT EXISTS fifth_codes(id INTEGER PRIMARY KEY,code TEXT); BEGIN;');
  const insert = db.prepare('INSERT OR REPLACE INTO fifth_codes VALUES(?,?)'); let imported = 0;
  for await (const line of archiveLines(archive, 'adminCode5.txt')) { const [id, code] = line.split('\t'); if (!/^\d+$/.test(id) || !code) continue; insert.run(Number(id), code); imported++; if (imported % 50000 === 0) db.exec('COMMIT;BEGIN;'); }
  db.exec('COMMIT;');
  const key = r => [r.country, r.a1, r.a2, r.a3, r.a4, r.code].join('.');
  const parents = new Map(); const ambiguous = new Set();
  for (const r of db.prepare("SELECT p.*,f.code FROM places p JOIN fifth_codes f ON f.id=p.id WHERE p.feature='ADM5'").iterate()) { const k = key(r); if (parents.has(k)) ambiguous.add(k); else parents.set(k, r.id); }
  for (const k of ambiguous) parents.delete(k);
  const update = db.prepare('UPDATE places SET parent_id=? WHERE id=?'); let linked = 0;
  db.exec('BEGIN;');
  for (const r of db.prepare("SELECT p.*,f.code FROM places p JOIN fifth_codes f ON f.id=p.id WHERE p.feature NOT LIKE 'ADM%' AND p.feature NOT LIKE 'PCL%'").iterate()) { const parent = parents.get(key(r)); if (parent) { update.run(parent, r.id); linked++; if (linked % 50000 === 0) db.exec('COMMIT;BEGIN;'); } }
  db.exec('COMMIT;');
  return { source: 'https://download.geonames.org/export/dump/adminCode5.zip', imported, linked, ambiguous: ambiguous.size };
}
