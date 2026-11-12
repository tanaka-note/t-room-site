import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.js';
import {encryptedFixture} from './encryption-fixture.mjs';
import {createEncryptedLedger} from '../public/encrypted-ledger.mjs';
import {encryptRow,decryptRow,recordKeys,keyScope,wrapMaster,unwrapMaster} from '../public/household-crypto.mjs';
import {manageKeys} from '../src/keys.js';

test('required encryption fails closed before setup and never accepts a legacy plaintext write',async()=>{
  const f=fixture();f.env.ENCRYPTION_REQUIRED='true';
  try{assert.equal((await (await f.login()).json()).cryptoRequired,true);
    for(const path of ['/api/data','/api/backup','/api/export.csv'])assert.equal((await f.request(path)).status,409);
    assert.equal((await f.request('/api/mutate',{requestId:crypto.randomUUID(),expectedRevision:0,operation:'transaction.save',value:{description:'must-not-persist'}})).status,409);
    assert.doesNotMatch(JSON.stringify(f.sqlite.prepare('SELECT * FROM household_records').all()),/must-not-persist/);
  }finally{f.close();}
});

test('migration encrypts active and retained generations, verifies exact plaintext, preserves metadata and isolates households',async()=>{
  const f=await encryptedFixture();
  try{
    const expected=f.seed();
    f.sqlite.exec("INSERT INTO household_requests(request_id,household_id,fingerprint,response_json) VALUES('old-plaintext-operation','main','legacy-input-hash','{\"ok\":true,\"revision\":0}')");
    f.sqlite.exec("INSERT INTO household_datasets(id,household_id,created_at,activated_at,retired_at) VALUES('retained','main','2026-01-01','2026-01-02','2026-01-03'); INSERT INTO household_records SELECT 'retained',kind,id,payload FROM household_records WHERE dataset_id='initial'");
    const independent=f.sqlite.prepare("SELECT * FROM household_records WHERE dataset_id='chiharu-initial'").all();
    const loaded=await f.unlock();
    assert.deepEqual(loaded.data,expected);assert.equal(loaded.revision,2);
    const receipt=f.sqlite.prepare("SELECT * FROM household_requests WHERE request_id='old-plaintext-operation'").get();assert.match(receipt.fingerprint,/^retired-plaintext:/);assert.equal(receipt.response_json,'{"ok":true,"revision":0}');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM household_datasets WHERE household_id='main' AND crypto_version=0").get().n,0);
    const retained=f.sqlite.prepare("SELECT * FROM household_datasets WHERE retired_at='2026-01-03'").get();assert.equal(retained.created_at,'2026-01-01');assert.equal(retained.activated_at,'2026-01-02');
    const wire=await (await f.request('/api/data')).json();
    assert.equal(wire.encrypted,true);assert.ok(wire.records.every(r=>/^[A-Za-z0-9_-]{43}$/.test(r.id)));
    assert.doesNotMatch(JSON.stringify(wire),/synthetic-private|12345|2026-11-01|食費/);
    const stored=f.sqlite.prepare("SELECT r.payload FROM household_records r JOIN household_datasets d ON d.id=r.dataset_id WHERE d.household_id='main'").all();
    assert.ok(stored.every(r=>JSON.parse(r.payload).version===1));
    assert.deepEqual(f.sqlite.prepare("SELECT * FROM household_records WHERE dataset_id='chiharu-initial'").all(),independent);
    assert.equal((await f.request('/api/export.csv')).status,409);
  }finally{f.close();}
});

test('AEAD binds household, key version, kind and opaque ID; encryption uses fresh IVs',async()=>{
  const f=await encryptedFixture();
  try{
    const keys=await recordKeys(f.master),value={id:crypto.randomUUID(),description:'fixture-only'};
    const a=await encryptRow(keys,f.config,'transactions',value),b=await encryptRow(keys,f.config,'transactions',value);
    assert.equal(a.id,b.id);assert.notEqual(a.payload.iv,b.payload.iv);assert.notEqual(a.payload.ciphertext,b.payload.ciphertext);
    assert.deepEqual(await decryptRow(keys,f.config,a),value);
    for(const altered of [{...a,kind:'accounts'},{...a,id:'a'.repeat(43)},{...a,payload:{...a.payload,ciphertext:'a'+a.payload.ciphertext.slice(1)}}])await assert.rejects(decryptRow(keys,f.config,altered));
    await assert.rejects(decryptRow(keys,{...f.config,householdId:'chiharu'},a));
    await assert.rejects(decryptRow(keys,{...f.config,keyId:crypto.randomUUID()},a));
    const large={id:crypto.randomUUID(),history:'synthetic-only'.repeat(25000)};
    assert.deepEqual(await decryptRow(keys,f.config,await encryptRow(keys,f.config,'accounts',large)),large,'large account histories must not overflow base64 argument limits');
  }finally{f.close();}
});

test('encrypted delta saves retain unchanged ciphertext; ambiguous retry uses the same envelope; stale edits fail',async()=>{
  const f=await encryptedFixture();
  try{
    f.seed();const first=await f.unlock();
    const before=f.sqlite.prepare('SELECT kind,id,payload FROM household_records ORDER BY kind,id').all();
    const value={...first.data.transactions[0],amount:9876},requestId=crypto.randomUUID();
    let fail=true;const captured=[];
    const api=async(path,body)=>{const result=await f.api(path,body);if(path==='/mutate'){captured.push(JSON.stringify(body));if(fail){fail=false;throw new Error('synthetic lost reply');}}return result;};
    const ledger=createEncryptedLedger(api,f.session);await ledger.unlock(f.prf.slice());
    await assert.rejects(ledger.mutate(first.data,'transaction.save',value,first.revision,requestId),/lost reply/);
    await ledger.mutate(first.data,'transaction.save',value,first.revision,requestId);assert.equal(captured[0],captured[1]);
    const after=await ledger.load();assert.equal(after.data.transactions[0].amount,9876);assert.equal(after.revision,first.revision+1);
    const unchanged=f.sqlite.prepare("SELECT kind,id,payload FROM household_records WHERE kind!='transactions' ORDER BY kind,id").all();
    assert.deepEqual(unchanged,before.filter(r=>r.kind!=='transactions'));
    await assert.rejects(f.ledger.mutate(first.data,'transaction.delete',{id:value.id},first.revision,crypto.randomUUID()),e=>e.status===409);
    ledger.clear();
  }finally{f.close();}
});

test('manual v3 backup authenticates the entire record set; legacy files are parsed locally and restored as ciphertext',async()=>{
  const f=await encryptedFixture();
  try{
    f.seed();const loaded=await f.unlock(),backup=await f.ledger.backup();assert.equal(backup.version,3);
    assert.doesNotMatch(JSON.stringify(backup),/synthetic-private|12345|2026-11-01/);
    assert.deepEqual(await f.ledger.readBackup(backup),loaded.data);
    for(const altered of [{...backup,records:backup.records.slice(1)},{...backup,records:[...backup.records,backup.records[0]]},{...backup,crypto:{...backup.crypto,recoveryWrappedKey:'tampered'}}])await assert.rejects(f.ledger.readBackup(altered));
    const legacy={format:'troom-household',version:2,data:loaded.data},local=await f.ledger.readBackup(legacy);
    const result=await f.ledger.restore(local,loaded.revision,crypto.randomUUID());assert.equal(result.revision,loaded.revision+1);
    assert.deepEqual((await f.ledger.load()).data,loaded.data);
    assert.match(f.ledger.csv(loaded.data),/-12345/);
    const restoredMaster=await unwrapMaster(f.recovery.privateKey,backup.crypto.recoveryWrappedKey,keyScope(backup.crypto));assert.deepEqual(restoredMaster,f.master);restoredMaster.fill(0);
  }finally{f.close();}
});

test('staging failure preserves the old generation and migration resumes on retry',async()=>{
  const f=await encryptedFixture();
  try{
    const expected=f.seed(),originalBatch=f.env.DB.batch;let once=true;
    f.env.DB.batch=async statements=>{if(once){once=false;throw new Error('synthetic staging failure');}return originalBatch(statements);};
    await assert.rejects(f.ledger.unlock(f.prf.slice()));
    assert.equal(f.sqlite.prepare("SELECT active_dataset FROM household_state WHERE id='main'").get().active_dataset,'initial');
    assert.equal(f.sqlite.prepare("SELECT crypto_version FROM household_datasets WHERE id='initial'").get().crypto_version,0);
    await f.ledger.unlock(f.prf.slice());assert.deepEqual((await f.ledger.load()).data,expected);
  }finally{f.close();}
});

test('an encrypted backup from another household is recovered only in the browser and re-encrypted with the destination key without importing permissions',async()=>{
  const source=await encryptedFixture(),destination=await encryptedFixture('chiharu-admin','sample-chiharu');
  const previous={fetch:globalThis.fetch,passkeys:globalThis.TRoomPasskeys,crypto:globalThis.TRoomCrypto};
  try{
    source.seed();const expected=await source.unlock(),backup=await source.ledger.backup(),current=await destination.unlock();
    globalThis.TRoomPasskeys={authenticate:async()=>({prfOutput:crypto.getRandomValues(new Uint8Array(32))})};
    globalThis.TRoomCrypto={unlockAdminPrivateKeyWithPasskey:async()=>source.recovery.privateKey};
    globalThis.fetch=async url=>{assert.equal(url,'/security/api/household/recovery');return Response.json({adminEnvelope:{synthetic:true}});};
    const data=await destination.ledger.readBackup(backup);
    assert.deepEqual(data,expected.data);
    await destination.ledger.restore(data,current.revision,crypto.randomUUID());
    const restored=await destination.ledger.load();assert.deepEqual(restored.data,expected.data);
    const wire=await destination.api('/data');assert.equal(wire.keyId,destination.config.keyId);assert.ok(wire.records.every(r=>r.payload.keyId===destination.config.keyId));
    assert.equal(destination.sqlite.prepare('SELECT COUNT(*) n FROM household_crypto_grants').get().n,1);
    assert.equal(destination.sqlite.prepare("SELECT household_id FROM household_accounts WHERE id='chiharu-admin'").get().household_id,'chiharu');
  }finally{globalThis.fetch=previous.fetch;globalThis.TRoomPasskeys=previous.passkeys;globalThis.TRoomCrypto=previous.crypto;source.close();destination.close();}
});

test('key envelopes are immutable and viewer sessions cannot migrate or write even with a decryption grant',async()=>{
  const f=await encryptedFixture('viewer','sample-viewer');
  try{
    await assert.rejects(manageKeys(f.env.DB,'grant',{serviceAccountId:'viewer',identityId:'sample-viewer',credentialId:'fixture-credential',serviceLinkId:'fixture-link',keyId:f.config.keyId,wrappedKey:'a'.repeat(512)}),e=>e.status===409);
    await assert.rejects(manageKeys(f.env.DB,'vault',{identityId:'another-identity',credentialId:'fixture-credential',vault:f.vault}),e=>e.status===409);
    for(const [path,body] of [['/api/encryption/migration',undefined],['/api/mutate',{requestId:crypto.randomUUID(),expectedRevision:0,keyId:f.config.keyId,records:[],deleted:[]}],['/api/restore',{}]])assert.equal((await f.request(path,body)).status,403);
    const other=await wrapMaster(f.master,f.vault.publicKey,keyScope({...f.config,householdId:'chiharu'}));
    const privateKey=await f.client.unlockClient(f.prf,f.vault);await assert.rejects(unwrapMaster(privateKey,other,keyScope(f.config)));
  }finally{f.close();}
});
