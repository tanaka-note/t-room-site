import assert from 'node:assert/strict';
import {test} from 'node:test';
import {systemFixture} from './system-fixture.mjs';
import {entry} from './fixture.mjs';
import {EncryptedDiaryClient} from '../../e2ee/client.mjs';
import {readSnapshotPages} from '../../e2ee/snapshot.mjs';
import {prepareRotation,rotationDigest,mediaBinding} from '../../e2ee/rotation.mjs';
import {openRecoveryEnvelope} from '../../e2ee/recovery.mjs';
import {bindingOf,verifyRecord} from '../../e2ee/record.mjs';
import {seal,open,signed} from '../../e2ee/crypto.mjs';
import {handleDiaryKeys} from '../../../security-worker/src/diary-keys.js';
import {backup,restoreEmpty} from '../../e2ee/backup.mjs';
import {memoryDatabase} from './sqlite.mjs';
import {createStore} from '../../e2ee/store.mjs';

test('central recovery rotates every record and personal preference, fences partial writes and preserves R2 references',async()=>{
  const f=await systemFixture(),owner=f.users['main-admin'];
  const central=async(path,body,user=owner)=>handleDiaryKeys('/api/diary'+path.split('?')[0],new Request('https://fixture.test/security/api/diary'+path,
    {method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),f.centralEnv,{...user,authenticatedAt:Date.now()/1000},f.helpers);
  const request=async(user,path,body)=>{
    const origin=f.env.DIARY_ENCRYPTION_ORIGIN,method=body===undefined?'GET':'POST';
    const response=await f.worker.fetch(new Request(origin+'/diary/api/encryption'+path,{method,
      headers:{Cookie:f.cookie(user.serviceAccountId,user),...(method==='POST'?{Origin:origin,'X-Diary-Request':'1','Content-Type':'application/json'}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),f.env,f.ctx);
    const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;
  };
  const client=async(user=owner)=>{
    const {profile}=await request(user,'/profile');
    const c=new EncryptedDiaryClient({profile,anchor:f.configuration.anchor,transport:{valid:async()=>true,
      timestamp:async()=>new Date().toISOString(),snapshot:(h,since)=>readSnapshotPages(options=>request(user,'/snapshot?'+new URLSearchParams(Object.entries(options).filter(([,v])=>v!==null))),h,since),
      mutation:(proposal,operation)=>request(user,'/mutation',{proposal,operation})}});
    await c.unlock(new Uint8Array(user.prf));return c;
  };
  const clients=[];
  try {
    const admin=await client(),reader=await client(f.users['main-user']),editor=await client(f.users['wife-admin']);clients.push(admin,reader,editor);
    const published=(await admin.saveEntry(entry())).entry;
    await reader.setFavorite(published.id,true);
    await editor.saveEntry({...entry(),status:'draft'});
    const trashed=(await editor.saveEntry({...entry(),title:'ROTATION_TRASH_CANARY'})).entry;
    await editor.transition(trashed.id,'trash');await admin.sync();await admin.transition(trashed.id,'purge');
    const oldKit=await openRecoveryEnvelope({packet:f.configuration.recoveryEnvelope,recoveryPrivateKey:f.recovery.privateKey,anchor:f.configuration.anchor});
    const photoId=crypto.randomUUID(),sessionId=crypto.randomUUID();
    const photo={id:photoId,household:'tanaka-household',account_id:'main-admin',session_id:sessionId,status:'attached',original_key:'diary/staging/original',display_key:'diary/staging/display',thumbnail_key:'diary/staging/thumb',metadata:'',epoch:1,request_hash:'opaque',expires_at:0,retired_at:null};
    const photoMetadata={id:photoId,fileName:'PRIVATE_PHOTO_NAME.jpg',width:100,height:100};
    photo.metadata=JSON.stringify(await seal(oldKit.scopeKeys.get('tanaka-household:preferences:main-admin'),photoMetadata,mediaBinding(photo)));
    f.db.sqlite.prepare('INSERT INTO diary_e2ee_media VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(photo));
    f.r2.set(photo.original_key,{bytes:new Uint8Array([1,2,3])});
    const originalR2=structuredClone([...f.r2]);
    f.central.sqlite.prepare("UPDATE security_credentials SET status='revoked' WHERE credential_id=?").run(f.users['wife-admin'].credentialId);
    await assert.rejects(admin.saveEntry(entry()),e=>e.status===423);
    await assert.rejects(central('/rotation/inventory'),/RotationRequiresPausedDatabase/);
    await central('/control',{expectedGeneration:1,next:'paused',evidence:null});
    const inventory=async kind=>{const rows=[];let after='';do{const page=await (await central('/rotation/inventory?'+new URLSearchParams({kind,after}))).json();rows.push(...page.rows);after=page.nextCursor;}while(after);return rows;};
    const records=await inventory('records'),media=await inventory('media'),status=await (await central('/admin')).json();
    const plan=await prepareRotation({status,recoveryPrivateKey:f.recovery.privateKey,trustedAnchor:f.configuration.anchor,records,media});
    assert.equal(plan.records.length,records.length);
    assert.equal(plan.configuration.directory.value.members.some(m=>m.credentialId===f.users['wife-admin'].recipientId),false);
    assert.equal(JSON.stringify(plan).includes('PRIVATE_PHOTO_NAME'),false);
    assert.equal(JSON.stringify(plan).includes(entry().content),false);
    const forged=structuredClone(plan.manifest);forged.value.records.count--;
    await assert.rejects(central('/rotation/begin',{configuration:plan.configuration,manifest:forged}),/InvalidSignature/);
    const begin=await central('/rotation/begin',{configuration:plan.configuration,manifest:plan.manifest});assert.equal(begin.status,200);
    assert.equal((await central('/rotation/begin',{configuration:plan.configuration,manifest:plan.manifest})).status,200);
    const manifestDigest=await rotationDigest(plan.manifest);
    await assert.rejects(central('/rotation/commit',{manifestDigest}),/IncompleteRotation/);
    const bad=structuredClone(plan.records[0]);bad.author='main-user';
    await assert.rejects(central('/rotation/stage',{kind:'records',rows:[bad]}),/InvalidSignature|RotationRecordChanged|UnauthorizedWriter/);
    await assert.rejects(central('/control',{expectedGeneration:2,next:'encrypted',evidence:null}),/RotationNotReady/);
    await assert.rejects(central('/rotation/stage',{kind:'records',rows:plan.records},f.users['chiharu-admin']),/AccessDenied/);
    for(const kind of ['records','media'])for(let i=0;i<plan[kind].length;i+=20){const rows=plan[kind].slice(i,i+20);await central('/rotation/stage',{kind,rows});await central('/rotation/stage',{kind,rows});}
    await central('/rotation/commit',{manifestDigest});await central('/rotation/commit',{manifestDigest});
    assert.equal(f.db.sqlite.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'paused');
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) count FROM diary_e2ee_rotation_items').get().count,0);
    assert.deepEqual([...f.r2],originalR2);
    await central('/config',plan.configuration);await central('/config',plan.configuration);
    const fresh=await client(),freshReader=await client(f.users['main-user']);clients.push(fresh,freshReader);
    await fresh.sync();await freshReader.sync();
    assert.equal(fresh.entry(published.id).content,published.content);
    assert.equal(freshReader.entry(published.id).isFavorite,true);
    const row=fresh.records.get(String(published.id)).row;
    await assert.rejects(open(oldKit.scopeKeys.get(row.scope),row.envelope,{...bindingOf(row),kind:'document'}));
    const nextKit=await openRecoveryEnvelope({packet:plan.configuration.recoveryEnvelope,recoveryPrivateKey:f.recovery.privateKey,anchor:f.configuration.anchor});
    assert.deepEqual(await open(nextKit.scopeKeys.get(mediaBinding(plan.media[0]).scope),JSON.parse(plan.media[0].metadata),mediaBinding(plan.media[0])),photoMetadata);
    const fake=structuredClone(row);fake.attestation.signature=records.find(r=>r.id===row.id).attestation.signature;
    await assert.rejects(verifyRecord(fake,plan.configuration.directory.value),/InvalidSignature/);
    // Current signed evidence is required to resume. The normal writer retains
    // the own-account preference restriction after the central recovery pass.
    const control=await f.integration.encryptionRollout();
    const sequence=f.db.sqlite.prepare('SELECT COALESCE(MAX(seq),0) seq FROM diary_e2ee_changes').get().seq;
    const proof=await signed({protocol:'T-lain diary cutover',version:2,records:records.length,sequence,directoryGeneration:2,
      sourceManifestDigest:await rotationDigest(plan.manifest),restoreDigest:await rotationDigest(plan.configuration),readerBuild:'fixture-reader',writerBuild:'fixture-writer',formats:[1,2]},fresh.privateKeys.sign);
    await central('/control',{expectedGeneration:control.generation,next:'encrypted',evidence:proof});
    await fresh.saveEntry({...entry(),title:'NEW_ENCRYPTED_POST'});
    await freshReader.setFavorite(published.id,false);
    await assert.rejects(client(f.users['wife-admin']),e=>e.status===409);
    assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM diary_e2ee_records').all()).includes('NEW_ENCRYPTED_POST'),false);
    // Restoring after a rotation verifies the recovery-only signatures and
    // personal preferences with the same public trust anchor.
    const archive=await backup(f.db,{directory:plan.configuration.directory,vaults:{},grants:plan.configuration.grants,recordGrants:plan.configuration.recordGrants,recoveryEnvelope:plan.configuration.recoveryEnvelope});
    const isolated=memoryDatabase({phase:'legacy'});
    try {
      await restoreEmpty(isolated,archive,{anchor:f.configuration.anchor,minimumGeneration:2});
      const store=createStore(isolated,{directory:plan.configuration.directory.value,epochs:plan.configuration.directory.value.epochs,households:status.households,photos:{}});
      freshReader.sequence=undefined;freshReader.records.clear();freshReader.transport.snapshot=(h,since)=>store.snapshot(freshReader.actor,h,since);
      await freshReader.sync();assert.equal(freshReader.entry(published.id).isFavorite,false);
    }finally{isolated.close();}
    oldKit.scopeKeys.clear();nextKit.scopeKeys.clear();
  } finally {for(const c of clients)c.lock();await f.close();}
});
