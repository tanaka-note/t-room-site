import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database,d1 } from './fixtures.mjs';
import { assertSchema } from '../src/schema-guard.js';
import { capture } from '../src/backup.js';
import { Bucket } from './fixtures.mjs';
import { compress,verifiedPut } from '../src/integrity.js';
import { restoreIsolated } from '../tools/restore-isolated.mjs';
import { saveExport } from '../src/export-backup.js';
import { exportEnv,exportFetcher } from './export-fixtures.mjs';
for(const [service,migration] of [['security','0033_windows_device_authority.sql'],['cloud','0014_windows_device_grants.sql']])
test(`${service} backup accepts only the exact optional Windows authorization schema`,async()=>{
  const db=database(service);
  try {
    const schema=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    await assertSchema(service,schema());
    db.exec(readFileSync(new URL(`../../${service}-worker/migrations/${migration}`,import.meta.url),'utf8'));
    await assertSchema(service,schema());
    const backup=await capture(d1(db),service);
    assert.equal(Object.keys(backup.tables).some(name=>name.includes('windows')),false,'authorization is not automatically restored from a data backup');
    if(service==='security')db.exec('DROP TRIGGER windows_link_delete');
    else db.exec('DROP INDEX cloud_windows_access_expiry');
    await assert.rejects(assertSchema(service,schema()),/SchemaReviewRequired/);
  } finally {db.close();}
});
test('Security backup restores pending encrypted T-Cloud delivery in isolation', async () => {
  const db = database('security');
  try {
    const schema = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    await assertSchema('security', schema());
    db.exec(readFileSync(new URL('../../security-worker/migrations/0034_tcloud_admin_key_transfers.sql', import.meta.url), 'utf8'));
    await assertSchema('security', schema());
    db.exec(`INSERT OR IGNORE INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1);
      INSERT OR IGNORE INTO security_service_links(id,identity_id,service,service_account_id,display_label,status)
        VALUES('approval-cloud','primary-admin','cloud','admin','Fixture Cloud','active');
      INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status)
        VALUES('transfer-source','primary-admin','public-fixture','salt-fixture','active'),
          ('transfer-target','primary-admin','public-fixture','salt-fixture','active');
      INSERT INTO security_tcloud_admin_key_transfers
        SELECT 'transfer-target','primary-admin',id,'public-envelope','public-fingerprint','sealed-receiver','receiver-iv',
          'transfer-source','admin-fingerprint','sealed-transfer','transfer-iv','sealed-wrapper'
        FROM security_service_links WHERE identity_id='primary-admin' AND service='cloud' AND service_account_id='admin' AND status='active';`);
    const backup = await capture(d1(db), 'security');
    assert.equal(backup.tables.security_tcloud_admin_key_transfers.rowCount, 1);
    assert.equal(backup.tables.security_tcloud_admin_key_transfers.rows[0].transfer_ciphertext, 'sealed-transfer');
    assert.equal(Object.hasOwn(backup.tables, 'security_tcloud_key_envelopes'), true);
    const bucket=new Bucket(),key='approval-security.json.gz';
    await verifiedPut(bucket,key,await compress(backup));
    await restoreIsolated(bucket,key,'security');
    db.exec("ALTER TABLE security_tcloud_admin_key_transfers ADD COLUMN unreviewed TEXT");
    await assert.rejects(assertSchema('security', schema()), /SchemaReviewRequired/);
  } finally { db.close(); }
});
test('catalog DDL remains exact alongside the reviewed trash backup and rebuilds without restoring device grants',async()=>{
  const db=database('cloud');
  try {
    const query="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name";
    for(const migration of ['0014_windows_device_grants.sql','0015_windows_sync_catalog.sql'])
      db.exec(readFileSync(new URL('../../cloud-worker/migrations/'+migration,import.meta.url),'utf8'));
    const combined=db.prepare(query).all();
    await assertSchema('cloud',combined);
    await assert.rejects(assertSchema('cloud',combined.filter(row=>row.name!=='cloud_windows_file_delete')),/SchemaReviewRequired/);
    db.exec("INSERT INTO cloud_folders(id,name,created_by) VALUES(1,'root','fixture'); INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by) VALUES(1,1,'opaque','fixture','application/octet-stream','document',10,'ready','fixture')");
    db.prepare(`INSERT INTO cloud_windows_devices(id,status,public_key_json,binding_json,scope_hash,enrollment_session_hash,enrollment_expires_at,created_at)
      VALUES(?,'active','{}','{}',?,?,0,0)`).run('a'.repeat(32),'b'.repeat(64),'c'.repeat(64));
    const epoch=db.prepare('SELECT epoch FROM cloud_windows_catalog_control').get().epoch;
    const backup=await capture(d1(db),'cloud');
    assert.equal(Object.keys(backup.tables).some(name=>name.startsWith('cloud_windows_')),false);
    const bucket=new Bucket(),key='d1/cloud/v2/daily/2026-11-19.json.gz';
    await verifiedPut(bucket,key,await compress(backup));
    const restored=await restoreIsolated(bucket,key,'cloud');
    try {
      assert.equal(restored.db.prepare('SELECT count(*) AS n FROM cloud_windows_devices').get().n,0);
      assert.notEqual(restored.db.prepare('SELECT epoch FROM cloud_windows_catalog_control').get().epoch,epoch);
      assert.equal(restored.db.prepare('SELECT count(*) AS n FROM cloud_windows_heads').get().n,2,'restored originals are visible in a fresh catalog');
      assert.equal(restored.db.prepare('SELECT cutover_ready FROM cloud_trash_control').get().cutover_ready,0,'purge acknowledgement is not restored');
    } finally {restored.db.close();}
  } finally {db.close();}
});
test('isolated Security recovery seeds new Windows generations only after quarantining restored Identities',async()=>{
  const source=database('security');
  try {
    source.exec(readFileSync(new URL('../../security-worker/migrations/0033_windows_device_authority.sql',import.meta.url),'utf8'));
    source.exec(`INSERT INTO security_identities(id,display_name,status) VALUES('windows-recovery','fixture','active');
      INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('recovery-credential','windows-recovery','public','salt','active');
      INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status)
        VALUES('recovery-link','windows-recovery','cloud','folder-member',7,'fixture','active');
      UPDATE security_windows_authority_versions SET revision=37;`);
    const bucket=new Bucket(),key='d1/security/v2/daily/2026-11-19.json.gz';
    await verifiedPut(bucket,key,await compress(await capture(d1(source),'security')));
    const {db}=await restoreIsolated(bucket,key,'security');
    try {
      assert.equal(db.prepare("SELECT status FROM security_identities WHERE id='windows-recovery'").get().status,'disabled');
      for(const id of ['windows-recovery','recovery-credential','recovery-link'])
        assert.equal(db.prepare('SELECT revision FROM security_windows_authority_versions WHERE entity_id=?').get(id).revision,1);
      db.exec("UPDATE security_identities SET status='active' WHERE id='windows-recovery'");
      assert.equal(db.prepare("SELECT revision FROM security_windows_authority_versions WHERE entity_id='windows-recovery'").get().revision,2,
        'normal reactivation observes the rebuilt generation rather than a missing counter');
    } finally {db.close();}
  } finally {source.close();}
});

test('version provenance and encrypted distinct restore names survive data backup without restoring upload authority',async()=>{
  const source=database('cloud');
  try {
    const bucket=new Bucket(),scheduled=Date.parse('2026-11-19T00:00:00Z');
    source.exec("INSERT INTO cloud_folders(id,name,created_by) VALUES(100,'legacy-root','fixture')");
    await saveExport(exportEnv('cloud',d1(source),bucket),'cloud',scheduled,{fetcher:exportFetcher(source,'cloud').fetcher});
    for(const migration of ['0014_windows_device_grants.sql','0015_windows_sync_catalog.sql','0016_windows_file_updates.sql'])
      source.exec(readFileSync(new URL('../../cloud-worker/migrations/'+migration,import.meta.url),'utf8'));
    source.exec(`INSERT INTO cloud_folders(id,name,created_by) VALUES(1,'root','fixture');
      INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by)
        VALUES(1,1,'current','current.txt','text/plain','document',10,'ready','fixture');
      INSERT INTO cloud_trash_operations(id,deleted_at,target_type,target_id) VALUES('old-version','2026-11-19T00:00:00Z','file',2);
      INSERT INTO cloud_files(id,folder_id,object_key,original_name,mime_type,media_kind,size_bytes,status,created_by,deleted_at,trash_operation_id)
        VALUES(2,1,'previous','previous.txt','text/plain','document',10,'ready','fixture','2026-11-19T00:00:00Z','old-version');
      INSERT INTO cloud_file_versions(file_id,source_file_id,source_revision,operation_id,content_version,restore_metadata,restore_iv)
        VALUES(2,1,3,'fixture-operation','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','encrypted-distinct-name','restore-iv');
      INSERT INTO cloud_windows_devices(id,status,public_key_json,binding_json,scope_hash,enrollment_session_hash,enrollment_expires_at,created_at)
        VALUES('device','active','{}','{}','scope','session',0,0);
      INSERT INTO cloud_windows_uploads(id,device_id,body_hash,epoch,upload_id,object_key,folder_id,ancestors)
        VALUES('pending-operation','device','hash','epoch',3,'unfinished',1,'[]');`);
    const backup=await capture(d1(source),'cloud');
    assert.equal(backup.expectedMigration,'0016_windows_file_updates.sql');
    assert.equal(backup.tables.cloud_file_versions.rows[0].restore_metadata,'encrypted-distinct-name');
    assert.equal(Object.keys(backup.tables).some(name=>name.startsWith('cloud_windows_')),false);
    const key='d1/cloud/v2/daily/2026-11-19.json.gz';
    await verifiedPut(bucket,key,await compress(backup));
    const {db}=await restoreIsolated(bucket,key,'cloud');
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM cloud_windows_uploads').get().n,0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM cloud_windows_devices').get().n,0);
      assert.equal(db.prepare('SELECT source_file_id FROM cloud_file_versions WHERE file_id=2').get().source_file_id,1);
      db.exec('UPDATE cloud_files SET deleted_at=NULL,trash_operation_id=NULL WHERE id=2');
      assert.equal(db.prepare('SELECT encrypted_metadata FROM cloud_files WHERE id=2').get().encrypted_metadata,'encrypted-distinct-name');
      assert.equal(db.prepare('SELECT object_key FROM cloud_files WHERE id=1').get().object_key,'current');
    } finally {db.close();}
    const schema=source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all();
    const {fetcher,calls}=exportFetcher(source,'cloud',{migration:'0016_windows_file_updates.sql'});
    const exported=await saveExport(exportEnv('cloud',d1(source),bucket),'cloud',scheduled,{fetcher});
    assert.ok(calls.length>0,'a same-day pre-migration export must not hide the new durable metadata');
    const recovered=await restoreIsolated(bucket,exported.daily,'cloud');
    try {
      assert.equal(recovered.payload.expectedMigration,'0016_windows_file_updates.sql');
      assert.equal(recovered.db.prepare('SELECT restore_iv FROM cloud_file_versions WHERE file_id=2').get().restore_iv,'restore-iv');
      assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM cloud_windows_uploads').get().n,0);
    }finally{recovered.db.close();}
    await assertSchema('cloud',schema);
    await assert.rejects(assertSchema('cloud',schema.filter(row=>row.name!=='cloud_version_restore_name')),/SchemaReviewRequired/);
    source.exec('ALTER TABLE cloud_windows_uploads ADD COLUMN unexpected TEXT');
    await assert.rejects(capture(d1(source),'cloud'),/SchemaReviewRequired/);
  }finally{source.close();}
});
