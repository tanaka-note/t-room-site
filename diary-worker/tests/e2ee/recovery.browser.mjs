// Actual browser runtime + actual Diary Worker/Security key handlers over local
// HTTP and in-memory SQLite/R2. PRF/reauth are synthetic, not a WebAuthn test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { systemFixture } from './system-fixture.mjs';
import { publicTrustPackage } from '../../e2ee/setup.mjs';
import { handleDiaryKeys } from '../../../security-worker/src/diary-keys.js';
import '../../../cloud-worker/public/crypto-vault.js';

const f = await systemFixture({recoveryExtractable:true}), user = f.users['main-admin'];
const root = fileURLToPath(new URL('../../../', import.meta.url));
const wire = [], errors = [];
let origin, loseResponse = true;
// Build a synthetic existing T-Cloud admin envelope using its real PRF wrapper.
// Fixture secrets stay in process memory and Playwright's isolated injection.
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
f.central.sqlite.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('fixture-existing-cloud','primary-admin','cloud','owner','Synthetic existing cloud','active')").run();
f.central.sqlite.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES('fixture-envelope','primary-admin',?,'fixture-existing-cloud','admin_private_prf',?,?)").run(user.credentialId, envelope.encryptedPayload, envelope.payloadIv);

const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, origin), path = url.pathname;
    if (path.includes('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      wire.push({path, body:body.toString()});
      const request = new Request(url, {method:req.method, headers:req.headers,
        ...(body.length ? {body, duplex:'half'} : {})});
      const reply = path.startsWith('/security/api/diary/')
        ? await handleDiaryKeys(path.slice('/security'.length), request, f.centralEnv,
          {...user, authenticatedAt:Date.now()/1000}, f.helpers)
        : await f.worker.fetch(request, f.env, f.ctx);
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
      : path.startsWith('/diary/') ? ['diary-worker/public', path.slice(7)]
      : path === '/cloud/crypto-vault.js' ? ['cloud-worker/public','crypto-vault.js'] : null;
    if (!mapping) {res.writeHead(404); res.end(); return;}
    const base = resolve(root,mapping[0]), file = resolve(base,mapping[1]);
    if (!file.startsWith(base+sep)) throw new Error('InvalidFixturePath');
    res.setHeader('Content-Type', ['.js','.mjs'].includes(extname(file)) ? 'text/javascript' : 'text/plain');
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
  await context.addCookies([{name:'troom_diary_session', value:f.cookie().slice('troom_diary_session='.length), url:origin}]);
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  const trust = await publicTrustPackage(f.configuration);
  await page.evaluate(({prf,credentialId,trust}) => {
    window.TRoomPasskeys = {authenticate:async () => ({credentialId, prfOutput:new Uint8Array(prf)})};
    localStorage.setItem('tlain-diary-authority-public-v1',JSON.stringify(trust));
  }, {prf:[...user.prf], credentialId:user.credentialId, trust});
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
  assert.deepEqual(errors,[]);
  await page.evaluate(() => window.fixtureBridge.lock());
  console.log('Recovery browser: real T-Cloud PRF envelope, Security setup response-loss retry, strict public trust and actual encrypted Diary HTTP runtime passed (synthetic authentication).');
} finally {await browser.close(); await new Promise(r => server.close(r)); await f.close();}
