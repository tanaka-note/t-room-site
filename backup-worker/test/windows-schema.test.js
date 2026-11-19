import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database,d1 } from './fixtures.mjs';
import { assertSchema } from '../src/schema-guard.js';
import { capture } from '../src/backup.js';
import { Bucket } from './fixtures.mjs';
import { compress,verifiedPut } from '../src/integrity.js';
import { restoreIsolated } from '../tools/restore-isolated.mjs';
for(const [service,migration] of [['security','0032_windows_device_authority.sql'],['cloud','0014_windows_device_grants.sql']])
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
    source.exec(readFileSync(new URL('../../security-worker/migrations/0032_windows_device_authority.sql',import.meta.url),'utf8'));
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
