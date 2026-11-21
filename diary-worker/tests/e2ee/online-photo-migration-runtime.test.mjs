import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {b64} from '../../e2ee/crypto.mjs';
import {encryptPhotoParts,PHOTO_PREFIX} from '../../e2ee/photo-crypto.mjs';
import {handlePhotoMigration} from '../../e2ee/photo-migration-store.mjs';
import {d1} from '../../../backup-worker/test/fixtures.mjs';

const require=createRequire(realpathSync(new URL('../../node_modules/wrangler/package.json',import.meta.url)));
const {Miniflare}=require('miniflare'),{build}=require('esbuild');

test('streamed migration PUT stores exactly one object in isolated workerd R2 and verifies its SHA-256', {timeout:45_000},async()=>{
  let runtime;
  try {
    const bundled=await build({stdin:{resolveDir:fileURLToPath(new URL('../../',import.meta.url)),contents:`
      import {putReservedPhotoPart} from './e2ee/photo-migration-store.mjs';
      export default {async fetch(request,env){try {
        const part={bytes:Number(request.headers.get('X-Test-Size')),sha256:request.headers.get('X-Test-Hash')};
        const stored=await putReservedPhotoPart(env.BUCKET,'synthetic-object',request,part);
        const head=await env.BUCKET.head('synthetic-object');
        return Response.json({created:Boolean(stored),size:head.size,sha256:[...new Uint8Array(head.checksums.sha256)]});
      }catch(error){return Response.json({error:error.message},{status:error.status||400});}}};`},bundle:true,format:'esm',platform:'browser',write:false});
    runtime=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-08-04',r2Buckets:{BUCKET:'synthetic-photo-bucket'}});
    const image=new Blob([new Uint8Array(3*1048576+17).fill(25)],{type:'image/jpeg'});
    const {parts}=await encryptPhotoParts({original:image,display:image,thumbnail:image},'synthetic',crypto.randomUUID());
    const encrypted=new Uint8Array(await parts.original.arrayBuffer()),sha=await crypto.subtle.digest('SHA-256',encrypted);
    const send=body=>runtime.dispatchFetch('http://fixture/',{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(body.length),
      'X-Test-Size':String(encrypted.length),'X-Test-Hash':b64(sha)},body});
    const first=await send(encrypted);assert.equal(first.status,200,await first.clone().text());assert.deepEqual(await first.json(),{created:true,size:encrypted.length,sha256:[...new Uint8Array(sha)]});
    const second=await send(encrypted);assert.equal(second.status,200,await second.clone().text());assert.equal((await second.json()).created,false);
  }finally {await runtime?.dispose();}
});

test('an existing checking run counts and pages only its own proofs with bounded responses',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../../e2ee/photo-migration.sql',import.meta.url),'utf8'));
    db.exec(`CREATE TABLE diary_e2ee_control (id INTEGER PRIMARY KEY, phase TEXT, generation INTEGER, ever_encrypted INTEGER, evidence TEXT);
      CREATE TABLE diary_e2ee_changes (seq INTEGER PRIMARY KEY);
      CREATE TABLE diary_e2ee_media (id TEXT PRIMARY KEY, household TEXT, original_key TEXT);`);
    const run=crypto.randomUUID(),token=crypto.randomUUID(),directory={generation:3},prefix=`${PHOTO_PREFIX}migration/${run}/`;
    const session={identityId:'primary-admin',sessionId:'test'};
    const actor={isGlobalOwner:true,canManageEntries:true,households:['tanaka-household','chiharu-household']};
    db.prepare("INSERT INTO diary_e2ee_control VALUES(1,'paused',3,1,?)").run(JSON.stringify({photoMigration:run}));
    db.prepare(`INSERT INTO diary_photo_migration_job(id,run,directory_generation,control_generation,phase,sequence,lease,lease_until)
      VALUES(1,?,3,3,'checking',0,?,?)`).run(run,'test:'+token,Date.now()+60_000);
    const media=db.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?)');
    const item=db.prepare("INSERT INTO diary_photo_migration_items VALUES(?,?,'{}','{}',?,7)");
    const ids=Array.from({length:451},(_,index)=>String(index+1).padStart(6,'0'));
    for(const [index,id] of ids.entries()) {
      const household=actor.households[index%2];
      media.run(id,household,`${prefix}${household}/${id}/original`);
      const check='a'.repeat(index<12?29_000:900);
      item.run(id,household,JSON.stringify({check}));
    }
    media.run('000000',actor.households[0],prefix.toUpperCase()+'unrelated');
    item.run('000000',actor.households[0],'{}');
    const env={DB:d1(db)};
    const get=(path,tokenForRequest=token)=>{
      const url=new URL(path,'https://fixture.test');
      const request=new Request(url,{headers:{'X-Diary-Photo-Session':tokenForRequest}});
      return handlePhotoMigration(request,env,url,url.pathname,{session,actor,bundle:{},directory,json:value=>value});
    };
    const status=await get('/status',crypto.randomUUID());
    assert.equal(status.phase,'checking');
    assert.equal(status.locked,true);
    assert.deepEqual(status.house.map(h=>h.verified),[226,225]);
    const received=[],pageLengths=[];
    let after='';
    do {
      const {rows,next}=await get('/proof-rows?after='+after);
      assert.ok(Buffer.byteLength(JSON.stringify(rows))<=256*1024+1);
      pageLengths.push(rows.length);
      received.push(...rows.map(row=>row.id));
      after=next;
    } while(after);
    assert.ok(pageLengths[0]<200,'large proofs stop at the byte limit');
    assert.equal(Math.max(...pageLengths),200);
    assert.deepEqual(received,ids);
  } finally {db.close();}
});
