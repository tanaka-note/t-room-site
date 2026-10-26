import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {database} from './fixtures.mjs';
import {SERVICES} from '../src/registry.js';
import {capture} from '../src/backup.js';
import {BACKUP_TABLES} from '../../diary-worker/src/backup.js';
import {snapshotStatement,snapshotTables} from '../src/snapshot.js';
// Use the exact runtime already pinned by Wrangler, without another dependency.
const {Miniflare,convertV4MiniflareOptions}=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)))('miniflare');

test('all service snapshots compile and honor global bounds in actual workerd D1', {timeout:120000},async()=>{
 const ids=[...Object.keys(SERVICES),'diary'];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',
  compatibilityDate:'2026-08-11',d1Databases:Object.fromEntries(ids.map(id=>[id,id]))}));
 try{
  for(const id of ids){
   const source=database(id),db=await mf.getD1Database(id);
   try{
    const schema=source.prepare("SELECT type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
    await db.batch(schema.map(row=>db.prepare(row.sql)));
    if(id!=='diary')assert.equal((await capture(db,id)).service,id);
    const tables=id==='diary'?BACKUP_TABLES:SERVICES[id].tables;
    // No production binding/data: exercise nonempty data and global rejection.
    if(id==='health')await db.prepare("INSERT INTO health_records VALUES ('fixture','nobumi','iv','ciphertext',1,'2026-01-01')").run();
    const result=await snapshotStatement(db,tables).all();
    assert.deepEqual(Object.keys(snapshotTables(result)),tables.map(t=>t.name));
    if(id==='health'){
     assert.equal(snapshotTables(result).health_records.rowCount,1);
     const blocked=await snapshotStatement(db,tables,{rows:0}).all();
     assert.equal(blocked.results[0].allowed,0);
     assert.ok(blocked.results.slice(1).every(row=>row.rowJson===null));
    }
   }finally{source.close();}
  }
 }finally{await mf.dispose();}
});
