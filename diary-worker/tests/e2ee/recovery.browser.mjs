// Actual browser runtime + actual Diary Worker/Security key handlers over local
// HTTP and in-memory SQLite/R2. PRF/reauth are synthetic, not a WebAuthn test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createHmac,randomBytes} from 'node:crypto';
import { chromium } from 'playwright';
import { systemFixture } from './system-fixture.mjs';
import { publicTrustPackage } from '../../e2ee/setup.mjs';
import { handleDiaryKeys } from '../../../security-worker/src/diary-keys.js';
import {Bucket} from '../../../backup-worker/test/fixtures.mjs';
import {exportFetcher,exportEnv} from '../../../backup-worker/test/export-fixtures.mjs';
import {saveExport} from '../../../backup-worker/src/export-backup.js';
import '../../../cloud-worker/public/crypto-vault.js';

let f = await systemFixture({recoveryExtractable:true}), user = f.users['main-admin'];
const {default:SecurityWorker}=await import('../../../security-worker/src/index.js');
const security=new SecurityWorker();security.env={...f.centralEnv,SESSION_SECRET:randomBytes(32).toString('base64url'),PASSKEY_ENABLED:'true'};security.ctx=f.ctx;
const securityCookie=kind=>{
  const value=Buffer.from(JSON.stringify({kind,identityId:user.identityId,credentialId:user.credentialId,passkeySessionEpoch:1,authenticatedAt:Math.floor(Date.now()/1000),authMethod:'passkey',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  return value+'.'+createHmac('sha256',security.env.SESSION_SECRET).update(value).digest('base64url');
};
const root = fileURLToPath(new URL('../../../', import.meta.url));
const wire = [], errors = [];
let origin, loseResponse = true, loseInvestmentResponse=true,failOwn=false;
const checkpoints=[];
f.env.D1_BACKUPS={create:async value=>{checkpoints.push(value);return {id:value.id};}};
// Build a synthetic existing T-Cloud admin envelope using its real PRF wrapper.
// Fixture secrets stay in process memory and Playwright's isolated injection.
async function addAdminEnvelope(f,user) {
const accountKey = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
const raw = new Uint8Array(await crypto.subtle.exportKey('pkcs8', f.recovery.privateKey));
let envelope;
try {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv,
    additionalData:new TextEncoder().encode('T-ROOM Cloud Storage admin private key v1')}, accountKey, raw);
  envelope = await TRoomCrypto.wrapAdminPrivateKeyForPasskey(accountKey, {
    adminPrivateCipher:Buffer.from(ciphertext).toString('base64url'), adminPrivateIv:Buffer.from(iv).toString('base64url'),
  }, user.prf);
} finally { raw.fill(0); }
f.central.sqlite.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('fixture-existing-cloud','primary-admin','cloud','owner','Synthetic existing cloud','active') ON CONFLICT DO NOTHING").run();
f.central.sqlite.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES(?,'primary-admin',?,'fixture-existing-cloud','admin_private_prf',?,?)").run('fixture-envelope-'+user.credentialId,user.credentialId, envelope.encryptedPayload, envelope.payloadIv);
}
await addAdminEnvelope(f,user);

const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, origin), path = url.pathname;
    if (path.includes('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      wire.push({path, body:body.toString()});
      if(path==='/security/api/diary/own'&&failOwn){failOwn=false;res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"synthetic internal diagnostic must stay private"}');return;}
      const request = new Request(url, {method:req.method, headers:req.headers,
        ...(body.length ? {body, duplex:'half'} : {})});
      const reply = path.startsWith('/security/api/diary/')
        ? await security.fetch(request)
        : await f.worker.fetch(request, f.env, f.ctx);
      if(path==='/security/api/diary/investment'&&req.method==='POST'&&loseInvestmentResponse){loseInvestmentResponse=false;res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"SyntheticResponseLoss"}');return;}
      if (path === '/security/api/diary/config' && loseResponse) {
        loseResponse = false; res.writeHead(503, {'Content-Type':'application/json'}); res.end('{"error":"SyntheticResponseLoss"}'); return;
      }
      const headers = Object.fromEntries(reply.headers);
      if (reply.headers.getSetCookie().length) headers['Set-Cookie'] = reply.headers.getSetCookie();
      res.writeHead(reply.status, headers); res.end(Buffer.from(await reply.arrayBuffer())); return;
    }
    if (path === '/') {
      res.setHeader('Content-Type','text/html'); res.end('<!doctype html><meta charset="utf-8"><script src="/cloud/crypto-vault.js"></script>'); return;
    }
    const mapping = path.startsWith('/security/') ? ['security-worker/public', path.slice(10)]
      : path.startsWith('/diary/') ? ['diary-worker/public',path==='/diary/investment/'?'investment.html':path.slice(7)]
      : path === '/cloud/crypto-vault.js' ? ['cloud-worker/public','crypto-vault.js'] : null;
    if (!mapping) {res.writeHead(404); res.end(); return;}
    const base = resolve(root,mapping[0]), file = resolve(base,mapping[1]);
    if (!file.startsWith(base+sep)) throw new Error('InvalidFixturePath');
    res.setHeader('Content-Type', ['.js','.mjs'].includes(extname(file)) ? 'text/javascript' : extname(file)==='.wasm'?'application/wasm':extname(file)==='.html'?'text/html':extname(file)==='.css'?'text/css':'text/plain');
    res.end(await readFile(file));
  } catch(error) {
    if (!error.status) errors.push(error.message);
    res.writeHead(error.status || 500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:error.message}));
  }
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
origin = `http://127.0.0.1:${server.address().port}`; f.env.DIARY_ENCRYPTION_ORIGIN = origin;
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext();
  await context.addCookies([{name:'troom_diary_session', value:f.cookie().slice('troom_diary_session='.length), domain:'127.0.0.1',path:'/diary'}]);
  await context.addCookies(['identity','admin'].map(kind=>({name:'troom_security_'+kind,value:securityCookie(kind),url:origin})));
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  const trust = await publicTrustPackage(f.configuration);
  await page.evaluate(({prf,credentialId,trust}) => {
    window.TRoomPasskeys = {authenticate:async () => {window.lastSetupPrf=new Uint8Array(prf);return {credentialId, prfOutput:window.lastSetupPrf};}};
    localStorage.setItem('tlain-diary-authority-public-v1',JSON.stringify(trust));
  }, {prf:[...user.prf], credentialId:user.credentialId, trust});
  assert.equal(await page.evaluate(async()=>typeof(await import('/security/diary-setup.mjs')).prepareDiaryData),'function','the published management entrypoint must connect to the migration controller');
  failOwn=true;
  const failure=await page.evaluate(async()=>{try{await(await import('/security/diary-setup.mjs')).configureDiary();return '';}catch(error){return error.message;}});
  assert.match(failure,/DKEY-VAULT-500/);assert.equal(failure.includes('synthetic internal'),false);
  assert.equal(await page.evaluate(()=>window.lastSetupPrf.every(value=>value===0)),true);
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,1);
  assert.equal(await page.evaluate(async () => {
    const setup = await import('/security/diary-setup.mjs');
    try {await setup.configureDiary();return false;} catch {return true;}
  }), true);
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
  assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('tlain-diary-authority-public-v1-pending'))),true);
  const recovered = await page.evaluate(async () => (await import('/security/diary-setup.mjs')).configureDiary());
  assert.equal(recovered.minimumGeneration,2);
  assert.equal(wire.filter(r => r.path === '/security/api/diary/config').length,1,'response-loss retry reads back the exact saved configuration');
  await page.evaluate(async () => (await import('/security/diary-setup.mjs')).configureDiary());
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,3);
  assert.equal(await page.evaluate(async () => {
    const {importDiaryTrust} = await import('/diary/diary-encryption.js');
    const key = 'tlain-diary-authority-public-v1', before = localStorage.getItem(key);
    const bad = {...JSON.parse(before), secret:'synthetic-secret-canary'};
    try {await importDiaryTrust(new File([JSON.stringify(bad)],'bad.json'));return false;}
    catch {return before === localStorage.getItem(key);}
  }),true);
  const canary = 'Synthetic private recovery diary body';
  const saved = await page.evaluate(async ({prf,credentialId,canary}) => {
    const {startEncryptedDiary} = await import('/diary/diary-encryption.js');
    const session = await (await fetch('/diary/api/session')).json();
    const bridge = await startEncryptedDiary(session,{credentialId,prfOutput:new Uint8Array(prf)});
    const result = await (await bridge.api('/entries',{method:'POST',body:{title:'Synthetic recovery title',
      content:canary, entryDate:'2026-11-12', entryTime:'10:00', tags:['synthetic-recovery'], state:'published'}})).json();
    window.fixtureBridge = bridge; return result.entry;
  }, {prf:[...user.prf], credentialId:user.credentialId, canary});
  assert.equal(saved.content,canary);
  const contents = await page.evaluate(async id => (await (await window.fixtureBridge.api(`/entries/${id}`)).json()).entry.content, saved.id);
  assert.equal(contents,canary);
  assert.equal(JSON.stringify(wire).includes(canary),false);
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes(canary),false);
  const financialRecords=[{date:'2026-01-01',total:7812345670,cash:7812345670,stocks:0,funds:0,bonds:0,crypto:0,futures:0,points:0,other:0},
    {date:'2026-02-01',total:7812345671,cash:7812345671,stocks:0,funds:0,bonds:0,crypto:0,futures:0,points:0,other:0}];
  assert.equal(await page.evaluate(async records=>{try{await (await import('/security/diary-setup.mjs')).importDiaryInvestment(new File([JSON.stringify({records})],'investment.json'));return false;}catch{return true;}},financialRecords),true);
  await page.evaluate(async records=>(await import('/security/diary-setup.mjs')).importDiaryInvestment(new File([JSON.stringify({records})],'investment.json')),financialRecords);
  const portfolio=await context.newPage();portfolio.on('pageerror',error=>errors.push(error.message));
  await portfolio.route('**/security/passkey-client.js*',route=>route.fulfill({contentType:'text/javascript',body:'/* Synthetic authentication is injected through the isolated test channel. */'}));
  await portfolio.addInitScript(({prf,credentialId})=>{window.TRoomPasskeys={authenticate:async()=>({credentialId,prfOutput:new Uint8Array(prf),link:{accountId:'main-admin'},handoff:{handoffToken:'main-admin'}})};},{prf:[...user.prf],credentialId:user.credentialId});
  await portfolio.goto(origin+'/diary/investment/');
  await portfolio.waitForSelector('#investment-passkey',{state:'visible'});await portfolio.click('#investment-passkey');
  await portfolio.waitForSelector('#dashboard:not([hidden])',{timeout:10000}).catch(async error=>{
    const reason=await portfolio.evaluate(async()=>{try{await(await import('/diary/investment-encryption.js')).loadEncryptedInvestment(await(await fetch('/diary/api/session')).json(),await TRoomPasskeys.authenticate());return 'direct retry succeeded';}catch(error){return error.message;}});
    throw new Error('Investment unlock: '+reason,{cause:error});
  });
  assert.equal((await portfolio.locator('#current-total').innerText()).replace(/[^0-9]/g,''),'7812345671');
  const investmentLogins=wire.filter(row=>row.path==='/diary/api/passkey/handoff').length;
  await portfolio.reload();await portfolio.waitForSelector('#dashboard:not([hidden])');
  assert.equal(wire.filter(row=>row.path==='/diary/api/passkey/handoff').length,investmentLogins,'investment reload reuses only its current live session device key');
  assert.equal(JSON.stringify(wire).includes('7812345670'),false);
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('7812345670'),false);
  const cache=await portfolio.evaluate(async()=>{const store=await (await import('/diary/crypto/e2ee/cache.mjs')).openCipherCache();const tx=JSON.stringify(await store.get('investment/main-admin/'+(await (await fetch('/diary/api/encryption/profile')).json()).profile.actor.credentialId));store.close();return tx;});
  assert.equal(cache.includes('7812345670'),false);
  await portfolio.close();
  // Exercise the same public management entrypoint as the real UI, through
  // Security's HTTP/session/mutation gates, rather than only the pure controller.
  await page.evaluate(()=>window.fixtureBridge.lock());await f.close();
  f=await systemFixture({phase:'legacy',recoveryExtractable:true});user=f.users['main-admin'];
  await addAdminEnvelope(f,user);f.env.DIARY_ENCRYPTION_ORIGIN=origin;
  f.env.D1_BACKUPS={create:async value=>{checkpoints.push(value);return {id:value.id};}};
  security.env={...f.centralEnv,SESSION_SECRET:randomBytes(32).toString('base64url'),PASSKEY_ENABLED:'true'};security.ctx=f.ctx;
  await context.addCookies(['identity','admin'].map(kind=>({name:'troom_security_'+kind,value:securityCookie(kind),url:origin})));
  await page.evaluate(({prf,credentialId,trust})=>{window.TRoomPasskeys={authenticate:async()=>{window.lastSetupPrf=new Uint8Array(prf);return {credentialId,prfOutput:window.lastSetupPrf};}};localStorage.setItem('tlain-diary-authority-public-v1',JSON.stringify(trust));},{prf:[...user.prf],credentialId:user.credentialId,trust:await publicTrustPackage(f.configuration)});
  f.db.sqlite.exec("INSERT INTO diary_entries(id,entry_date,title,content,author_id,author_name,household_id) VALUES(900,'2026-11-15','Setup migration title','SETUP_LEGACY_PRIVATE','main-admin','Synthetic owner','tanaka-household');");
  const photoId=crypto.randomUUID();
  f.db.sqlite.prepare("INSERT INTO diary_photos(id,entry_id,file_name,content_type,original_size,original_key,display_key,thumbnail_key,created_by_id,created_by_name,created_at) VALUES(?,900,'SETUP_PRIVATE_PHOTO.jpg','image/jpeg',3,?,?,?,'main-admin','Synthetic owner','2026-11-15')").run(photoId,'diary/staging/'+photoId+'/original','diary/staging/'+photoId+'/display','diary/staging/'+photoId+'/thumbnail');
  f.db.sqlite.exec(readFileSync(new URL('../../e2ee/legacy-fences.sql',import.meta.url),'utf8'));
  const pausedVault=f.central.sqlite.prepare('SELECT * FROM security_diary_key_vaults WHERE recipient_id=?').get(f.users['main-user'].recipientId);
  f.central.sqlite.prepare('DELETE FROM security_diary_key_vaults WHERE recipient_id=?').run(pausedVault.recipient_id);
  const waiting=await page.evaluate(async()=>{try{await(await import('/security/diary-setup.mjs')).prepareDiaryData();return '';}catch(error){return error.message;}});
  assert.match(waiting,/全利用者/);assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'legacy');assert.equal(checkpoints.length,0);
  f.central.sqlite.prepare('INSERT INTO security_diary_key_vaults VALUES(?,?,?,?,?,?)').run(...Object.values(pausedVault));
  const result=await page.evaluate(async()=>(await import('/security/diary-setup.mjs')).prepareDiaryData());
  assert.equal(result.requiresRestoreDrill,true);assert.match(result.checkpoint.key,/^v10\/checkpoints\/[a-f0-9-]+\.json\.gz$/);
  assert.equal(checkpoints.length,1);assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'migrating');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_entries').get().count,1,'the management entrypoint must not delete source data or cut over before restore verification');
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('SETUP_LEGACY_PRIVATE'),false);
  assert.equal(await page.evaluate(()=>window.lastSetupPrf.every(value=>value===0)),true);
  const bucket=new Bucket();f.env.BACKUP=bucket;
  f.env.ASSETS={fetch:async()=>new Response('<meta name="troom-app-build" content="diary-0123456789ab">')};
  f.env.D1_BACKUPS={create:async value=>{
    const mock=exportFetcher(f.db.sqlite,'diary',{migration:'diary-e2ee-v1'});
    await saveExport({...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central},'diary',Date.now(),{checkpoint:value.params.checkpoint,fetcher:mock.fetcher,sleep:async()=>{}});
    return {id:value.id};
  }};
  let downloads=0;page.on('download',()=>downloads++);
  assert.deepEqual(await page.evaluate(async()=>(await import('/security/diary-setup.mjs')).migrateDiary()),{completed:true});
  assert.equal(downloads,0,'migration and actual SQLite restore require no downloaded/imported files');
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_entries').get().count,0);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_e2ee_media').get().count,1);
  assert.equal(f.r2.size,0,'photo objects must not be rewritten or removed');
  assert.equal(JSON.stringify(wire).includes('SETUP_LEGACY_PRIVATE'),false,'legacy plaintext must never be sent back in migration requests');
  assert.equal(await page.evaluate(()=>window.lastSetupPrf.every(value=>value===0)),true);
  // Password recovery/new admin passkey must rotate BEFORE asking for a grant
  // signed by the new credential. The former admin credentials are revoked.
  const previous=user.credentialId;
  user={...user,credentialId:'fixture-recovered-admin',prf:crypto.getRandomValues(new Uint8Array(32))};
  f.central.sqlite.prepare("INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status,prf_enabled) VALUES(?,'primary-admin','synthetic','synthetic','active',1)").run(user.credentialId);
  f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(previous);
  await addAdminEnvelope(f,user);
  await context.addCookies(['identity','admin'].map(kind=>({name:'troom_security_'+kind,value:securityCookie(kind),url:origin})));
  await page.evaluate(({prf,credentialId})=>{window.TRoomPasskeys={authenticate:async()=>{window.lastSetupPrf=new Uint8Array(prf);return {credentialId,prfOutput:window.lastSetupPrf};}};},{prf:[...user.prf],credentialId:user.credentialId});
  assert.deepEqual(await page.evaluate(async()=>(await import('/security/diary-setup.mjs')).migrateDiary({kind:'rotation'})),{completed:true});
  assert.equal(f.central.sqlite.prepare('SELECT generation FROM security_diary_key_config').get().generation,2);
  assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'encrypted');
  assert.equal(await page.evaluate(()=>window.lastSetupPrf.every(value=>value===0)),true);user.prf.fill(0);
  assert.deepEqual(errors,[]);
  await page.evaluate(() => window.fixtureBridge?.lock());
  console.log('Recovery browser: full Security HTTP/session gates, real T-Cloud PRF envelope, safe setup diagnostics, encrypted Diary/Investment, and the public migration entrypoint through checkpoint creation passed (synthetic authentication).');
} finally {await browser.close(); await new Promise(r => server.close(r)); await f.close();}

await import('./automatic-preparation.browser.mjs');
await import('./unified-passkey.browser.mjs');
await import('./real-passkey.browser.mjs');
