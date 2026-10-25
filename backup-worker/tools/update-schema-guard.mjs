// Run only after reviewing migration changes. Never reads a remote database.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SERVICES } from '../src/registry.js';
import { digest } from '../src/integrity.js';
const hashes={};
for(const service of [...Object.keys(SERVICES),'diary']) {
  const db=new DatabaseSync(':memory:');
  try {
    const dir=new URL(`../../${service}-worker/migrations/`,import.meta.url);
    for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file,dir),'utf8'));
    const rows=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    hashes[service]=await digest(new TextEncoder().encode(JSON.stringify(rows.filter(r=>r.tbl_name!=='d1_migrations').map(r=>[r.type,r.name,r.tbl_name,r.sql.replace(/\r\n?/g,'\n')]))));
  } finally {db.close();}
}
const path=new URL('../src/schema-guard.js',import.meta.url);
const source=readFileSync(path,'utf8').replace(/const EXPECTED = \{[\s\S]*?\};/,`const EXPECTED = ${JSON.stringify(hashes,null,2)};`);
writeFileSync(path,source);
