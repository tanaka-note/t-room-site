import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {systemFixture} from './system-fixture.mjs';
import {b64,open,unb64} from '../../e2ee/crypto.mjs';
import {publicTrustPackage} from '../../e2ee/setup.mjs';
import {LEGACY_TABLES,prepareMigration} from '../../e2ee/migration.mjs';
import {importMigration} from '../../e2ee/migration-store.mjs';
import {parseRecord} from '../../e2ee/store.mjs';
import {bindingOf} from '../../e2ee/record.mjs';
import {openRecoveryEnvelope} from '../../e2ee/recovery.mjs';
import {decryptPhotoPart} from '../../e2ee/photo-crypto.mjs';
import {PHOTO_RETENTION_MS} from '../../e2ee/photo-migration-store.mjs';
import {Bucket} from '../../../backup-worker/test/fixtures.mjs';
import {exportFetcher,exportEnv} from '../../../backup-worker/test/export-fixtures.mjs';
import {saveExport} from '../../../backup-worker/src/export-backup.js';

const f=await systemFixture({phase:'legacy',recoveryExtractable:true}), owner=f.users['main-admin'];
const trust=await publicTrustPackage(f.configuration),db=f.db.sqlite,media=new Map(),writes=new Map();
const kinds=['original','display','thumbnail'],root=resolve(import.meta.dirname,'../../public');
const source=new Map(),photoIds=[crypto.randomUUID(),crypto.randomUUID()];
let origin, server, browser, lostPut=false, lostCheckpoint=false, copies=0, deleteCalls=0;
const errors=[];
const digest=(algorithm,body)=>createHash(algorithm).update(body).digest();
const migrationRoot='/diary/api/encryption/photo-migration';
const token=crypto.randomUUID();

try {
  const raw=new Uint8Array(await crypto.subtle.exportKey('pkcs8',f.recovery.privateKey));
  const context='T-ROOM Cloud Storage passkey admin private key v1',encoder=new TextEncoder();
  const material=await crypto.subtle.importKey('raw',owner.prf,'HKDF',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:await crypto.subtle.digest('SHA-256',encoder.encode(context+'|salt')),
    info:encoder.encode(context)},material,{name:'AES-GCM',length:256},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const payload=b64(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(context)},key,raw));raw.fill(0);
  f.central.sqlite.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('fixture-cloud','primary-admin','cloud','owner','Synthetic cloud','active')").run();
  f.central.sqlite.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES('test-envelope','primary-admin',?,'fixture-cloud','admin_private_prf',?,?)")
    .run(owner.credentialId,payload,b64(iv));

  for(const [index,household,author] of [[0,'tanaka-household','main-admin'],[1,'chiharu-household','chiharu-admin']]) {
    const id=photoIds[index],entryId=index+1,old=Object.fromEntries(kinds.map(kind=>[kind,`diary/staging/${id}/${kind}`]));
    const content=`PRIVATE_DIARY_TEST_${index} [[写真:${id}]]`;
    db.prepare('INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id) VALUES(?,?,?,?,?,?,?)').run(entryId,'2026-11-18','Private title',content,author,'Synthetic author',household);
    db.prepare(`INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name,created_at)
      VALUES(?,?,'PRIVATE_PHOTO_NAME.jpg','image/jpeg',3,?,?,?,?,'Synthetic author','2026-11-18')`).run(id,entryId,old.original,old.display,old.thumbnail,author);
    for(const kind of kinds) {
      const bytes=new Uint8Array([255,index,kinds.indexOf(kind)]),etag=digest('md5',bytes).toString('hex');
      source.set(old[kind],bytes);media.set(old[kind],{bytes,etag});
    }
  }
  db.prepare(`INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id,status,draft_of_entry_id,draft_of_revision)
    VALUES(3,'2026-11-18','Synthetic draft',?,'main-admin','Synthetic author','tanaka-household','draft',1,1)`).run(`[[写真:${photoIds[0]}]]`);
  db.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../../e2ee/photo-migration.sql',import.meta.url),'utf8'));
  db.exec("UPDATE diary_e2ee_control SET phase='migrating',generation=1");
  const old=Object.fromEntries(LEGACY_TABLES.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const plan=await prepareMigration({source:old,configuration:{...f.configuration,generation:1},recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor});
  for(const kind of ['records','media'])await importMigration(f.db,{kind,rows:plan[kind],directory:f.configuration.directory.value,expectedGeneration:1});
  db.exec("UPDATE diary_e2ee_control SET phase='purging',ever_encrypted=1; DELETE FROM diary_photos; DELETE FROM diary_entries; UPDATE diary_e2ee_control SET phase='encrypted',generation=2");

  function object(value,body=false) {
    return value?{size:value.bytes.length,etag:value.etag,httpEtag:`"${value.etag}"`,checksums:value.sha256?{sha256:value.sha256}:{},
      ...(body?{body:new Blob([value.bytes]).stream()}:{})}:null;
  }
  f.env.MEDIA={
    async get(key,options){const value=media.get(key);return object(value,!options?.onlyIf||options.onlyIf.etagMatches===value?.etag);},
    async head(key){return object(media.get(key));},
    async put(key,stream,options){
      const bytes=new Uint8Array(await new Response(stream).arrayBuffer());
      if(options.onlyIf?.etagDoesNotMatch==='*'&&media.has(key))return null;
      const sha256=digest('sha256',bytes);assert.equal(b64(options.sha256),b64(sha256));
      assert.equal(source.has(key),false);const value={bytes,etag:digest('md5',bytes).toString('hex'),sha256};
      writes.set(key,(writes.get(key)||0)+1);media.set(key,value);return object(value);
    },
    async delete(){deleteCalls++;throw new Error('Deletion must never run');},
  };
  const bucket=new Bucket();f.env.BACKUP=bucket;
  f.env.D1_BACKUPS={create:async value=>{
    copies++;
    const mock=exportFetcher(db,'diary',{migration:'diary-e2ee-v1'});
    await saveExport({...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central},'diary',Date.now(),{checkpoint:value.params.checkpoint,fetcher:mock.fetcher,sleep:async()=>{}});
    return {id:value.id};
  }};
  f.env.ASSETS={fetch:async request=>{
    const path=new URL(request.url).pathname, file=resolve(root,path==='/'?'index.html':path.slice(1));
    assert.ok(file.startsWith(root+sep));
    const type={'.html':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm'}[extname(file)]||'application/octet-stream';
    return new Response(await readFile(file),{headers:{'Content-Type':type}});
  }};
  server=createServer(async (req,res)=>{
    try {
      const url=new URL(req.url,origin);
      if(url.pathname==='/security/passkey-client.js') {res.writeHead(200,{'Content-Type':'text/javascript'});res.end('');return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
      if(url.pathname.startsWith(migrationRoot)&&req.method!=='GET')assert.equal(body.includes(Buffer.from('PRIVATE_PHOTO_NAME.jpg')),false);
      const response=await f.worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),f.env,f.ctx);
      if(response.ok&&req.method==='PUT'&&!lostPut){lostPut=true;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"SyntheticResponseLoss"}');return;}
      if(response.ok&&url.pathname===migrationRoot+'/backup'&&req.method==='POST'&&!lostCheckpoint){
        lostCheckpoint=true;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"SyntheticResponseLoss"}');return;
      }
      const headers=Object.fromEntries(response.headers);
      if(response.headers.getSetCookie().length)headers['set-cookie']=response.headers.getSetCookie();
      res.writeHead(response.status,headers);res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(error.message);res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;f.env.DIARY_ENCRYPTION_ORIGIN=origin;
  const status=account=>f.worker.fetch(new Request(origin+migrationRoot+'/status',{headers:{Cookie:f.cookie(account),'X-Diary-Photo-Session':token}}),f.env,f.ctx);
  assert.equal((await status('main-admin')).status,404);
  f.env.DIARY_PHOTO_MIGRATION_ENABLED='true';
  assert.equal((await status('main-user')).status,403);assert.equal((await status('chiharu-admin')).status,403);

  browser=await chromium.launch();
  async function login() {
    const context=await browser.newContext(),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(({credentialId,prf,trust})=>{
      window.TRoomPasskeys={authenticate:async()=>{window.testPrf=new Uint8Array(prf);return {credentialId,prfOutput:window.testPrf,handoff:{handoffToken:'main-admin',diaryTrust:trust}};}};
    },{credentialId:owner.credentialId,prf:[...owner.prf],trust});
    await page.goto(origin+'/diary/photo-encryption-migration/');await page.click('#passkey-login');
    await page.locator('#existing-photo-migration-view').waitFor({state:'visible'}).catch(async error=>{
      throw new Error(`Synthetic login: ${await page.locator('#login-message').textContent()} (${errors.join(',')})`,{cause:error});
    });
    assert.equal(await page.evaluate(()=>window.testPrf.every(value=>value===0)),true);
    return {context,page};
  }
  const run=async()=>{const client=await login();await client.page.click('#existing-photo-migration-start');return client;};
  const first=await run();
  await first.page.getByText('移行を中断しました。保存済みの進捗を確認して再開してください。').waitFor();
  assert.equal(lostPut,true);assert.equal(writes.size,1);assert.equal(db.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  await first.context.close();
  const manual=await login();
  const cancelTarget=Promise.withResolvers();
  await manual.page.route('**/photo-migration/target/**',async route=>{
    await cancelTarget.promise;
    await route.abort().catch(()=>{});
  });
  try {
    await Promise.all([manual.page.waitForRequest('**/photo-migration/target/**'),manual.page.click('#existing-photo-migration-start')]);
    const contender=await manual.context.request.post(origin+migrationRoot+'/acquire',{
      headers:{Origin:origin,'X-Diary-Request':'1','X-Diary-Photo-Session':crypto.randomUUID()},data:{}});
    assert.equal(contender.status(),409);
    assert.equal((await contender.json()).error,'PhotoMigrationBusy');
    await manual.page.click('#existing-photo-migration-stop');
    await manual.page.getByText('中断しました。保存済みの進捗から再開できます。').waitFor();
    await manual.page.locator('#existing-photo-migration-stop').waitFor({state:'hidden'});
    assert.equal(writes.size,1);
  } finally {
    cancelTarget.resolve();await manual.context.close();
  }
  const second=await run();
  await second.page.getByText(/準備が完了しました。/).waitFor();
  assert.equal(db.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  // A changed Diary sequence invalidates the prepared signed rows, but does
  // not reupload any of the verified photo bodies.
  db.exec("UPDATE diary_e2ee_records SET revision=revision WHERE id='1'");
  await second.page.getByRole('button',{name:'復元確認と切替を開始'}).click();
  await second.page.getByText(/準備が完了しました。/).waitFor();
  assert.equal(db.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  await second.page.getByRole('button',{name:'復元確認と切替を開始'}).click();
  await second.page.getByText('移行を中断しました。保存済みの進捗を確認して再開してください。').waitFor();
  assert.equal(lostCheckpoint,true);assert.equal(writes.size,6);assert.ok([...writes.values()].every(count=>count===1));
  const paused=db.prepare('SELECT * FROM diary_e2ee_control').get();assert.equal(paused.phase,'paused');assert.ok(JSON.parse(paused.evidence).photoMigration);
  const image=await f.worker.fetch(new Request(`${origin}/diary/api/photos/${photoIds[1]}/original`,{headers:{Cookie:f.cookie('chiharu-admin')}}),f.env,f.ctx);
  assert.equal(image.status,423,'candidate images remain unavailable without a verified restored backup');
  await assert.rejects(saveExport({...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central},'diary',Date.now(),
    {fetcher:async()=>{throw new Error('ordinary export must not run while checking');}}),/PhotoMigrationChecking/);
  await second.context.close();
  const before=Date.now(),third=await run();
  await third.page.getByText(/両世帯の切替が完了しました。/).waitFor();
  assert.equal(copies,2);assert.equal(deleteCalls,0);assert.equal(media.size,12);
  for(const [key,bytes] of source)assert.deepEqual(media.get(key).bytes,bytes);
  const job=db.prepare('SELECT * FROM diary_photo_migration_job').get();assert.equal(job.phase,'done');
  assert.ok(job.retained_until>=before+PHOTO_RETENTION_MS&&job.retained_until<=Date.now()+PHOTO_RETENTION_MS);
  const kit=await openRecoveryEnvelope({packet:f.configuration.recoveryEnvelope,recoveryPrivateKey:f.recovery.privateKey,anchor:trust.anchor});
  try {
    for(const id of [1,2,3]) {
      const row=parseRecord(db.prepare('SELECT * FROM diary_e2ee_records WHERE id=?').get(String(id)));
      const {entry}=await open(kit.scopeKeys.get(row.scope),row.envelope,{...bindingOf(row),kind:'document'});
      assert.equal(entry.photos.length,1);const photo=entry.photos[0],stored=db.prepare('SELECT * FROM diary_e2ee_media WHERE id=?').get(photo.id);
      for(const kind of kinds) {
        const cipher=media.get(stored[`${kind}_key`]).bytes;
        const restored=await decryptPhotoPart(cipher,photo.crypto,row.household,photo.id,kind);
        assert.deepEqual(new Uint8Array(await restored.arrayBuffer()),source.get(`diary/staging/${photo.id}/${kind}`));
      }
      if(id===3)assert.equal(row.sourceRevision,db.prepare("SELECT revision FROM diary_e2ee_records WHERE id='1'").get().revision);
    }
  }finally {kit.scopeKeys.clear();}
  const other=await f.worker.fetch(new Request(`${origin}/diary/api/photos/${photoIds[0]}/original`,{headers:{Cookie:f.cookie('chiharu-admin')}}),f.env,f.ctx);
  assert.equal(other.status,404);assert.deepEqual(errors,[]);
  await third.context.close();console.log('Online Diary photo migration: both households, lost responses, manual pause, exclusive lease, new browser sessions, isolated SQLite restore, protected cutover, draft continuity and seven-day retention passed.');
} finally {
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await f.close();
}
