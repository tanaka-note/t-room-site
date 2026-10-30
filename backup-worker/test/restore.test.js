import test from 'node:test';
import assert from 'node:assert/strict';
import { database,d1,Bucket,recorder } from './fixtures.mjs';
import { backupService } from '../src/backup.js';
import { SERVICES } from '../src/registry.js';
import { restoreIsolated } from '../tools/restore-isolated.mjs';

const insert=(db,t,row)=>db.prepare(`INSERT INTO ${t} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
const b64=b=>Buffer.from(b).toString('base64');
const un64=s=>Buffer.from(s,'base64');

test('stored R2 generations of all configured services restore nonempty business data, keys and totals in isolation',async()=>{
  // Synthetic keys exist only in this process. This proves preservation of the
  // encryption relationships, not production PRF/physical-device recovery.
  const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
  const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['wrapKey','unwrapKey']);
  const publicJson=JSON.stringify(await crypto.subtle.exportKey('jwk',rsa.publicKey));
  const wrapped=b64(await crypto.subtle.wrapKey('raw',aes,rsa.publicKey,'RSA-OAEP'));
  const folderKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['wrapKey','unwrapKey']);
  const folderWrapped=b64(await crypto.subtle.wrapKey('raw',folderKey,rsa.publicKey,'RSA-OAEP'));
  const wrapIv=crypto.getRandomValues(new Uint8Array(12));
  const fileWrapped=b64(await crypto.subtle.wrapKey('raw',aes,folderKey,{name:'AES-GCM',iv:wrapIv}));
  const vaultKek=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const vaultIv=crypto.getRandomValues(new Uint8Array(12));
  const vaultCipher=b64(await crypto.subtle.encrypt({name:'AES-GCM',iv:vaultIv},vaultKek,new TextEncoder().encode(JSON.stringify(await crypto.subtle.exportKey('jwk',rsa.privateKey)))));
  const iv=crypto.getRandomValues(new Uint8Array(12)), text=new TextEncoder().encode('synthetic encrypted content');
  const ciphertext=b64(await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,text)), ivText=b64(iv);
  const restored={};
  try {
    for(const service of Object.keys(SERVICES)) {
      const source=database(service), bucket=new Bucket();
      try {
        if(service==='cloud') {
          insert(source,'cloud_crypto_config',{id:1,crypto_version:1,public_key_jwk:publicJson,admin_private_cipher:vaultCipher,admin_private_iv:b64(vaultIv),recovery_private_cipher:vaultCipher,recovery_private_iv:b64(vaultIv)});
          insert(source,'cloud_folders',{id:101,name:'encrypted folder',created_by:'admin',crypto_version:1,admin_wrapped_key:folderWrapped});
          insert(source,'cloud_files',{folder_id:101,object_key:'encrypted-content-only',original_name:'fixture',mime_type:'application/octet-stream',media_kind:'document',size_bytes:100,status:'ready',created_by:'admin',crypto_version:1,wrapped_file_key:fileWrapped,file_key_iv:b64(wrapIv),encrypted_metadata:ciphertext,metadata_iv:ivText});
        }
        if(service==='security') {
          insert(source,'security_identities',{id:'primary-admin',display_name:'synthetic',status:'active',is_security_admin:1});
          for(const status of ['active','revoked']) insert(source,'security_credentials',{credential_id:status,identity_id:'primary-admin',public_key:'synthetic-public',prf_salt:'synthetic-salt',status});
          insert(source,'security_service_links',{id:'link',identity_id:'primary-admin',service:'cloud',service_account_id:'admin',display_label:'synthetic',status:'active'});
          insert(source,'security_tcloud_client_vaults',{credential_id:'active',identity_id:'primary-admin',public_key_jwk:publicJson,public_key_fingerprint:'synthetic',encrypted_payload:vaultCipher,payload_iv:b64(vaultIv)});
          insert(source,'security_tcloud_key_envelopes',{id:'envelope',identity_id:'primary-admin',credential_id:'active',service_link_id:'link',envelope_type:'folder_key_rsa',wrapped_key:wrapped});
          insert(source,'security_health_config',{account_id:'nobumi',recovery_wrapped_key:wrapped,recovery_public_key:publicJson});
          insert(source,'security_audit_events',{event_id:'event',occurred_at:'2026-10-01T00:00:00Z',service:'cloud',event_type:'passkey_login_success',outcome:'success',identity_id:'primary-admin'});
        }
        if(service==='health') insert(source,'health_records',{record_id:'record',account_id:'nobumi',iv:ivText,ciphertext,revision:3,updated_at:'2026-10-01'});
        if(service==='billing') {
          insert(source,'billing_opening_balances',{account_id:'owner',effective_date:'2026-01-01',balance_yen:1000,updated_by:'owner'});
          insert(source,'billing_entries',{account_id:'owner',document_type:'invoice',entry_date:'2026-01-02',category:'purchase',amount_yen:12345,description:'synthetic',created_by:'owner'});
          insert(source,'billing_settlements',{account_id:'owner',settlement_date:'2026-01-03',direction:'incoming',method:'cash',amount_yen:2345,created_by:'owner'});
        }
        if(service==='payments') {
          insert(source,'payments_accounts',{id:'owner',display_name:'synthetic'});
          insert(source,'payments_entries',{id:'entry',account_id:'owner',paid_on:'2026-01-01',payee:'synthetic',amount:1001,start_month:'2026-01',months:3,created_at:'2026-01-01',updated_at:'2026-01-01'});
          for(const [month,amount] of [['01',334],['02',334],['03',333]]) insert(source,'payments_monthly_marks',{entry_id:'entry',target_month:'2026-'+month,amount,completed_at:'2026-04-01'});
          insert(source,'payments_requests',{request_id:'request',fingerprint:'synthetic',response_json:'{}',created_at:'2026-01-01'});
          insert(source,'payments_operation_audit',{request_id:'request',entry_id:'entry',action:'entry_create',occurred_at:'2026-01-01',identity_id:'primary-admin',account_id:'owner',entry_version:1,amount:1001});
        }
        if(service==='inventory') {
          insert(source,'inventory_accounts',{id:'owner',display_name:'synthetic'});
          insert(source,'inventory_items',{id:'item',account_id:'owner',name:'synthetic',unit:'個',created_at:'2026-01-01'});
          for(const [id,kind,quantity_delta] of [['open','opening',10],['used','use',-3]]) insert(source,'inventory_movements',{id,account_id:'owner',item_id:'item',kind,quantity_delta,occurred_at:'2026-01-01',created_at:'2026-01-01'});
        }
        if(service==='ai') {
          insert(source,'ai_accounts',{identity_id:'primary-admin',display_name:'synthetic'});
          insert(source,'ai_conversations',{id:'conversation',identity_id:'primary-admin',character_id:'zundamon'});
          insert(source,'ai_messages',{id:'message',conversation_id:'conversation',identity_id:'primary-admin',character_id:'zundamon',role:'user',content:'synthetic conversation'});
          insert(source,'ai_usage_events',{request_id:'usage',identity_id:'primary-admin',character_id:'zundamon',conversation_id:'conversation',model:'synthetic',estimated_cost_micros_jpy:1234,usage_period:'2026-10',occurred_at:'2026-10-01'});
          insert(source,'ai_budget_guards',{identity_id:'primary-admin',usage_period:'2026-10',spent_micros_jpy:1234,reserved_micros_jpy:500});
          insert(source,'ai_request_claims',{client_request_id:'processing',identity_id:'primary-admin',conversation_id:'conversation',character_id:'zundamon',status:'processing',model:'synthetic',reserved_micros_jpy:500});
        }
        if(service==='downloader') insert(source,'downloader_usage_daily',{day_jst:'2026-10-01',identity_id:'primary-admin',metric:'download',dimension:'all',event_count:3,byte_count:1234,value_sum:0,value_max:0,updated_at:'2026-10-01'});
        if(service==='calendar') {
          for(const [kind,id,payload] of [['track','track',{id:'track',name:'synthetic tracking'}],['tag','tag',{id:'tag',name:'synthetic tag'}],['event','event',{id:'event',title:'synthetic appointment',trackIds:['track'],tagIds:['tag']}],['settings','preferences',{reminders:[60],theme:'lavender'}]]) {
            insert(source,'calendar_entities',{account_id:'main',owner_identity:kind==='settings'?'primary-admin':'',kind,id,payload:JSON.stringify(payload),version:3});
          }
        }
        const state=await backupService({[SERVICES[service].binding]:d1(source),BACKUP:bucket,...recorder()},service,Date.parse('2026-10-25T00:00:00Z'),async()=>{});
        assert.equal(state.state,'ok',service);
        restored[service]=(await restoreIsolated(bucket,`d1/${service}/v2/daily/2026-10-25.json.gz`,service)).db;
      } finally {source.close();}
    }
    assert.equal(restored.inventory.prepare('SELECT stock FROM inventory_items').get().stock,7,'no trigger replay doubles stock');
    assert.equal(restored.inventory.prepare('SELECT sum(quantity_delta) AS total FROM inventory_movements').get().total,7);
    assert.equal(restored.payments.prepare('SELECT sum(amount) AS total FROM payments_monthly_marks').get().total,1001);
    assert.equal(restored.billing.prepare('SELECT sum(amount_yen) AS total FROM billing_entries').get().total,12345);
    assert.equal(restored.billing.prepare('SELECT sum(amount_yen) AS total FROM billing_settlements').get().total,2345);
    assert.equal(restored.ai.prepare('SELECT spent_micros_jpy FROM ai_budget_guards').get().spent_micros_jpy,1234);
    assert.equal(restored.ai.prepare('SELECT status FROM ai_request_claims').get().status,'failed');
    assert.equal(restored.security.prepare("SELECT count(*) AS n FROM security_credentials WHERE status='active'").get().n,0);
    assert.equal(restored.security.prepare("SELECT count(*) AS n FROM security_service_links WHERE status='active'").get().n,0);
    for(const s of ['billing','payments','inventory','calendar']) assert.equal(restored[s].prepare(`SELECT sum(is_active) AS n FROM ${s}_accounts`).get().n,0);
    const calendarEvent=restored.calendar.prepare("SELECT payload,version FROM calendar_entities WHERE kind='event'").get();
    assert.equal(calendarEvent.version,3);assert.equal(JSON.parse(calendarEvent.payload).title,'synthetic appointment');
    assert.deepEqual(JSON.parse(calendarEvent.payload).trackIds,['track']);assert.deepEqual(JSON.parse(calendarEvent.payload).tagIds,['tag']);
    assert.equal(JSON.parse(restored.calendar.prepare("SELECT payload FROM calendar_entities WHERE kind='track'").get().payload).name,'synthetic tracking');
    assert.deepEqual(JSON.parse(restored.calendar.prepare("SELECT payload FROM calendar_entities WHERE kind='settings' AND owner_identity='primary-admin'").get().payload).reminders,[60]);
    assert.equal(restored.calendar.prepare('SELECT value FROM calendar_clock').get().value,4,'restore preserves the cursor without replaying triggers');
    assert.equal(restored.calendar.prepare("SELECT session_version FROM calendar_accounts WHERE id='main'").get().session_version,2,'isolated restore invalidates previous sessions');
    const cloud=restored.cloud.prepare('SELECT * FROM cloud_files').get(), health=restored.health.prepare('SELECT * FROM health_records').get();
    const vault=restored.security.prepare('SELECT * FROM security_tcloud_client_vaults').get();
    const privateJwk=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(vault.payload_iv)},vaultKek,un64(vault.encrypted_payload))));
    const recoveredRsa=await crypto.subtle.importKey('jwk',privateJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['unwrapKey']);
    const recoveredFolder=await crypto.subtle.unwrapKey('raw',un64(restored.cloud.prepare('SELECT admin_wrapped_key FROM cloud_folders WHERE id=101').get().admin_wrapped_key),recoveredRsa,'RSA-OAEP','AES-GCM',false,['unwrapKey']);
    const recoveredFile=await crypto.subtle.unwrapKey('raw',un64(cloud.wrapped_file_key),recoveredFolder,{name:'AES-GCM',iv:un64(cloud.file_key_iv)},'AES-GCM',false,['decrypt']);
    assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(cloud.metadata_iv)},recoveredFile,un64(cloud.encrypted_metadata))),text);
    const recoveredHealth=await crypto.subtle.unwrapKey('raw',un64(restored.security.prepare('SELECT recovery_wrapped_key AS k FROM security_health_config').get().k),recoveredRsa,'RSA-OAEP','AES-GCM',false,['decrypt']);
    assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(health.iv)},recoveredHealth,un64(health.ciphertext))),text);
    assert.equal(cloud.encrypted_metadata,ciphertext);
    assert.equal(restored.security.prepare('SELECT encrypted_payload FROM security_tcloud_client_vaults').get().encrypted_payload,vaultCipher);
  } finally {for(const db of Object.values(restored)) db.close();}
});
