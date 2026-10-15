import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';

export function archiveLines(path, filename) {
  const fd=openSync(path,'r'), size=statSync(path).size;
  const tail=Buffer.alloc(Math.min(size,65557));readSync(fd,tail,0,tail.length,size-tail.length);
  let end=tail.length-22;while(end>=0&&tail.readUInt32LE(end)!==0x06054b50)end--;
  if(end<0)throw Error('Invalid GeoNames ZIP');
  const directory=Buffer.alloc(tail.readUInt32LE(end+12));readSync(fd,directory,0,directory.length,tail.readUInt32LE(end+16));
  let offset=0,entry;
  while(offset<directory.length){const n=directory.readUInt16LE(offset+28),x=directory.readUInt16LE(offset+30),c=directory.readUInt16LE(offset+32);if(directory.toString('utf8',offset+46,offset+46+n)===filename){entry={length:directory.readUInt32LE(offset+20),offset:directory.readUInt32LE(offset+42),method:directory.readUInt16LE(offset+10)};break;}offset+=46+n+x+c;}
  if(!entry||entry.method!==8)throw Error('Unsupported GeoNames ZIP entry');
  const header=Buffer.alloc(30);readSync(fd,header,0,30,entry.offset);closeSync(fd);
  const start=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);
  return createInterface({input:createReadStream(path,{start,end:start+entry.length-1}).pipe(createInflateRaw()),crlfDelay:Infinity});
}
