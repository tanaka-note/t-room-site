import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {database} from './fixtures.mjs';
import {sqlDump} from './export-fixtures.mjs';
import {readExportManifest} from '../src/export-backup.js';
const require=createRequire(realpathSync(new URL('../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');

test('native Workers fetch exports into actual R2 with a lease and rejects API/download redirects without forwarding credentials', {timeout:120000},async()=>{
 const source=database('health');let mf;
 try{
  source.exec("INSERT INTO health_records VALUES('fixture','nobumi','iv','synthetic ciphertext',1,'now')");
  const sql=sqlDump(source,'health'),calls=[];let mode='success';
  const bundled=await build({stdin:{contents:`
   import {saveExport,pruneExports} from './src/export-backup.js';
   import {withExportLease} from './src/export-lease.js';
   export default {async fetch(request,env){try{
    const now=Date.parse('2026-11-01T18:40:00Z')+Number(new URL(request.url).pathname.slice(1))*86400000;
    const result=await withExportLease(env.BACKUP,'health',async guard=>{
     const saved=await saveExport(env,'health',now,{guard});await pruneExports(env.BACKUP,'health',guard);return saved;
    });return Response.json(result);
   }catch(e){return Response.json({error:e.message},{status:500});}}};`,resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,format:'esm',platform:'browser',write:false});
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-11',
   d1Databases:{HEALTH_DB:'export-fixture'},r2Buckets:{BACKUP:'backup-fixture'},
   bindings:{D1_EXPORT_ACCOUNT_ID:'0'.repeat(32),D1_EXPORT_API_TOKEN:'fixture-export-credential'},
   outboundService:async request=>{
    const host=new URL(request.url).hostname;calls.push(host);
    if(host==='api.cloudflare.com'){
     assert.equal(request.headers.get('Authorization'),'Bearer fixture-export-credential');
     if(mode==='api-redirect')return Response.redirect('https://forbidden.invalid/',307);
     return Response.json({success:true,result:{status:'complete',at_bookmark:'fixture-bookmark',result:{signed_url:'https://fixture.r2.cloudflarestorage.com/export'}}});
    }
    assert.equal(host,'fixture.r2.cloudflarestorage.com','redirect targets must never be fetched');
    assert.equal(request.headers.get('Authorization'),null,'API credential must not reach the download origin');
    return mode==='download-redirect'?Response.redirect('https://forbidden.invalid/',302):new Response(sql);
   }}));
  const db=await mf.getD1Database('HEALTH_DB'),bucket=await mf.getR2Bucket('BACKUP');
  const schema=source.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all();
  await db.batch(schema.map(s=>db.prepare(s.sql)));
  const saved=await mf.dispatchFetch('http://fixture/0');assert.equal(saved.status,200,await saved.clone().text());
  const keys=await saved.json(),manifest=await readExportManifest(bucket,keys.daily,'health');
  assert.equal(manifest.payload.tables.health_records.rowCount,1);
  assert.equal((await readExportManifest(bucket,keys.monthly,'health')).sha256,manifest.sha256);
  for(const scenario of ['api-redirect','download-redirect']){
   mode=scenario;calls.length=0;
   const response=await mf.dispatchFetch('http://fixture/1');assert.equal(response.status,500);
   assert.deepEqual(await response.json(),{error:'ExportUnavailable'});
   assert.ok(!calls.includes('forbidden.invalid'));assert.equal(await bucket.get('d1/health/v3/daily/2026-11-03.json.gz'),null);
   assert.equal((await readExportManifest(bucket,keys.daily,'health')).sha256,manifest.sha256,'failed requests preserve prior recovery points');
  }
 }finally{source.close();await mf?.dispose();}
});
