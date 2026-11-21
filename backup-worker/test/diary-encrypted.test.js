import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {systemFixture} from '../../diary-worker/tests/e2ee/system-fixture.mjs';
import {entry} from '../../diary-worker/tests/e2ee/fixture.mjs';
import {EncryptedDiaryClient} from '../../diary-worker/e2ee/client.mjs';
import {createStore} from '../../diary-worker/e2ee/store.mjs';
import {saveExport,readExportManifest,readExportParts} from '../src/export-backup.js';
import {DIARY_ENCRYPTED_MIGRATION,SECURITY_DIARY_MIGRATION} from '../src/diary-encrypted.js';
import {restoreIsolated} from '../tools/restore-isolated.mjs';
import {Bucket,d1} from './fixtures.mjs';
import {exportEnv,exportFetcher} from './export-fixtures.mjs';
import {compress,verifiedPut} from '../src/integrity.js';
import {scanBackupMetadata} from '../../diary-worker/src/backup-browser.js';
import {storageSnapshot} from '../src/browser.js';
import {sealTrust,openTrust} from '../../diary-worker/e2ee/trust.mjs';
import {publicTrustPackage} from '../../diary-worker/e2ee/setup.mjs';
const now=Date.UTC(2026,10,15,18,25),sleep=async()=>{};

test('encrypted fixed exports include same-generation keys and restore over 10,000 rows without photo object writes',async()=>{
  const f=await systemFixture(),bucket=new Bucket();let restored,securityRestore;
  try {
    f.db.sqlite.exec(readFileSync(new URL('../../diary-worker/e2ee/legacy-fences.sql',import.meta.url),'utf8'));
    const user=f.users['main-user'],profile={actor:{...user.claims,credentialId:user.recipientId,active:true},household:'tanaka-household',vault:user.vault,
      directory:f.configuration.directory,epochs:f.configuration.directory.value.epochs,grants:f.configuration.grants[user.recipientId]};
    const trust=await publicTrustPackage(f.configuration),sealed=await sealTrust(user.prf,user.recipientId,trust);
    f.central.sqlite.prepare('UPDATE security_diary_key_vaults SET vault_json=? WHERE recipient_id=?').run(JSON.stringify({...user.vault,trust:sealed}),user.recipientId);
    const registry={directory:profile.directory.value,epochs:profile.epochs,households:profile.directory.value.households,photos:{}};
    const store=createStore(f.db,registry),c=new EncryptedDiaryClient({profile,anchor:f.configuration.anchor,transport:{valid:async()=>true,timestamp:async()=>new Date().toISOString(),snapshot:(h,since)=>store.snapshot(profile.actor,h,since),mutation:(proposal,operation)=>store.mutation(profile.actor,proposal,operation)}});
    await c.unlock(new Uint8Array(user.prf));const post=(await c.saveEntry({...entry(),title:'ENCRYPTED_EXPORT_PRIVATE_CANARY'})).entry;await c.setFavorite(post.id,true);
    f.db.sqlite.exec("WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<12000) INSERT INTO diary_e2ee_changes(id,household,revision,deleted) SELECT '1','tanaka-household',v,0 FROM n");
    f.db.sqlite.exec(readFileSync(new URL('../../diary-worker/e2ee/photo-reference-index.sql',import.meta.url),'utf8'));
    const env={...exportEnv('diary',f.db,bucket),SECURITY_DB:f.central};
    const mock=exportFetcher(f.db.sqlite,'diary',{migration:DIARY_ENCRYPTED_MIGRATION});
    const saved=await saveExport(env,'diary',now,{fetcher:mock.fetcher,sleep});assert.match(saved.daily,/^v10\/daily/);
    const manifest=await readExportManifest(bucket,saved.daily,'diary');
    assert.equal(manifest.payload.tables.diary_e2ee_changes.rowCount,12002);
    assert.equal(manifest.payload.schema.some(row=>row.name.startsWith('diary_photo_refs')),false);
    assert.equal(Object.hasOwn(manifest.payload.tables,'diary_photo_refs'),false);
    assert.equal(Object.hasOwn(manifest.payload.tables,'diary_entries'),false);
    assert.ok(manifest.payload.keyMetadata.vaults[user.recipientId]);
    assert.deepEqual(await openTrust(user.prf,user.recipientId,manifest.payload.keyMetadata.vaults[user.recipientId].trust),trust);
    for await(const part of readExportParts(bucket,manifest.payload,'diary'))assert.equal(JSON.stringify(part).includes('ENCRYPTED_EXPORT_PRIVATE_CANARY'),false);
    await assert.rejects(restoreIsolated(bucket,saved.daily,'diary'),/DiaryTrustedAnchorRequired/);
    restored=await restoreIsolated(bucket,saved.daily,'diary',{anchor:f.configuration.anchor,minimumGeneration:1});
    assert.equal(restored.db.prepare('SELECT phase FROM diary_e2ee_control').get().phase,'paused');
    assert.equal(restored.db.prepare('SELECT COUNT(*) count FROM diary_e2ee_changes').get().count,12002);
    const restoredStore=createStore(d1(restored.db),registry);c.sequence=undefined;c.records.clear();c.transport.snapshot=(h,since)=>restoredStore.snapshot(profile.actor,h,since);await c.sync();
    assert.equal(c.entry(post.id).title,'ENCRYPTED_EXPORT_PRIVATE_CANARY');assert.equal(c.entry(post.id).isFavorite,true);
    const stats=await scanBackupMetadata(bucket);assert.equal(stats.encryptedDaily.objectCount,1);assert.equal(stats.daily.objectCount,1);assert.ok(stats.d1Bytes>0);
    assert.equal(f.r2.size,0);
    const securityMock=exportFetcher(f.central.sqlite,'security',{migration:SECURITY_DIARY_MIGRATION});
    const securitySaved=await saveExport(exportEnv('security',f.central,bucket),'security',now,{fetcher:securityMock.fetcher,sleep});assert.match(securitySaved.daily,/^d1\/security\/v4/);
    securityRestore=await restoreIsolated(bucket,securitySaved.daily,'security');
    assert.equal(securityRestore.db.prepare('SELECT generation FROM security_diary_key_config').get().generation,1);
    assert.equal(securityRestore.db.prepare('SELECT COUNT(*) count FROM security_diary_key_vaults').get().count,4);
    const securityStats=await storageSnapshot({BACKUP:bucket},false,null);assert.equal(securityStats.services.find(s=>s.id==='security').daily.length,1);
    // A checksum can be recomputed by an attacker. Signed grants still reject
    // substitution against the operator's separately trusted authority.
    const bad=structuredClone(manifest.payload);bad.keyMetadata.grants[user.recipientId][0].value.accountId='wife-admin';
    const badBucket=new Bucket();for(const [key,value] of bucket.objects)badBucket.objects.set(key,structuredClone(value));
    await verifiedPut(badBucket,saved.daily,await compress(bad),{});
    await assert.rejects(restoreIsolated(badBucket,saved.daily,'diary',{anchor:f.configuration.anchor}),/InvalidSignature/);
    // A changing key generation aborts publication and keeps the last verified
    // daily/monthly generations. Only newly owned candidate parts are removed.
    const tomorrow=now+86400000,beforeKeys=[...bucket.objects.keys()].sort();
    const changed=exportFetcher(f.db.sqlite,'diary',{migration:DIARY_ENCRYPTED_MIGRATION,onStart:()=>f.central.sqlite.exec('UPDATE security_diary_key_config SET generation=2')});
    await assert.rejects(saveExport(env,'diary',tomorrow,{fetcher:changed.fetcher,sleep}));
    assert.deepEqual([...bucket.objects.keys()].sort(),beforeKeys);
    f.central.sqlite.exec('UPDATE security_diary_key_config SET generation=1');
    f.db.sqlite.exec('DROP TRIGGER diary_photo_refs_record_update');
    await assert.rejects(saveExport(env,'diary',tomorrow,{fetcher:mock.fetcher,sleep}),/SchemaReviewRequired/);
    await assert.rejects(saveExport(env,'diary',tomorrow,{fetcher:mock.fetcher,sleep}),/SchemaReviewRequired/);
    c.lock();
  }finally{restored?.db.close();securityRestore?.db.close();await f.close();}
});
