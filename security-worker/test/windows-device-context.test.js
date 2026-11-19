import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { cloudWindowsDeviceContext } from '../src/windows-device-context.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort())
    db.exec(readFileSync(new URL('../migrations/'+file, import.meta.url), 'utf8'));
  db.exec(`INSERT INTO security_identities(id,display_name,status) VALUES('fixture','Fixture','active');
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,prf_enabled,status)
      VALUES('credential','fixture','public','salt',1,'active');
    INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status)
      VALUES('link','fixture','cloud','folder-member',7,'Folder','active');
    INSERT INTO security_tcloud_client_vaults(credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv)
      VALUES('credential','fixture','{"kty":"RSA","n":"fixture","e":"AQAB"}','fingerprint','cipher','iv');
    INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key)
      VALUES('envelope','fixture','credential','link','folder_key_rsa','wrapped-ciphertext');`);
  const statement = (sql, args=[]) => ({ bind: (...values) => statement(sql,values),
    first: async () => db.prepare(sql).get(...args) || null });
  const input = { service:'cloud',identityId:'fixture',credentialId:'credential',serviceLinkId:'link',
    serviceAccountId:'folder-member',cloudRootFolderId:7,sessionEpoch:1 };
  return { db, input, read: (extra={}, validation={valid:true}) => cloudWindowsDeviceContext({ DB:{prepare:statement} }, {...input,...extra}, async()=>validation) };
}
test('Windows context returns only public and RSA-wrapped folder keys, scoped to active authority', async()=> {
  const f=fixture(); try {
    const value=await f.read(); assert.equal(value.valid,true); assert.match(value.authorityVersion,/^[a-f0-9]{64}$/);
    assert.deepEqual(value.folderKeys,[{serviceLinkId:'link',rootFolderId:7,wrappedKey:'wrapped-ciphertext'}]);
    assert.equal(JSON.stringify(value).includes('encryptedPayload'),false); assert.equal(JSON.stringify(value).includes('salt'),false);
    assert.equal(await f.read({cloudRootFolderId:8}),null);
    assert.equal(await f.read({}, {valid:false}),null);
    assert.equal(await f.read({service:'diary'}),null);
    f.db.exec("UPDATE security_credentials SET prf_enabled=0 WHERE credential_id='credential'");
    assert.equal(await f.read(),null);
  } finally {f.db.close();}
});
test('disable/re-enable and revoke/reactivate permanently change the Windows authority vector', async()=> {
  for (const [table,column,key] of [['security_identities','id','fixture'],['security_credentials','credential_id','credential'],['security_service_links','id','link']]) {
    const f=fixture(); try {
      const original=await f.read();
      f.db.prepare(`UPDATE ${table} SET status=? WHERE ${column}=?`).run(table==='security_credentials'?'revoked':'disabled',key);
      assert.equal(await f.read(),null);
      f.db.prepare(`UPDATE ${table} SET status='active' WHERE ${column}=?`).run(key);
      assert.notEqual((await f.read()).authorityVersion,original.authorityVersion);
    } finally {f.db.close();}
  }
});
test('routine login counters and display changes do not invalidate a registered device', async()=> {
  const f=fixture(); try {
    const original=await f.read();
    f.db.exec("UPDATE security_credentials SET counter=counter+1,last_used_at=CURRENT_TIMESTAMP; UPDATE security_identities SET display_name='Changed'; UPDATE security_service_links SET display_label='Changed'");
    assert.equal((await f.read()).authorityVersion,original.authorityVersion);
    assert.notEqual((await f.read({sessionEpoch:2})).authorityVersion,original.authorityVersion);
    f.db.exec("DELETE FROM security_service_links WHERE id='link'");
    assert.equal(await f.read(),null);
    const generation=f.db.prepare("SELECT revision FROM security_windows_authority_versions WHERE kind='link' AND entity_id='link'").get().revision;
    f.db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES('link','fixture','cloud','folder-member',7,'Folder','active')");
    assert.ok(f.db.prepare("SELECT revision FROM security_windows_authority_versions WHERE kind='link' AND entity_id='link'").get().revision>generation);
  } finally {f.db.close();}
});
