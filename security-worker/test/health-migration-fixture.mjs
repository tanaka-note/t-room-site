import { readFileSync, readdirSync } from 'node:fs';

export const migrationDirectory = new URL('../migrations/', import.meta.url);
export const migrationNames = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
export const migrationSql = name => readFileSync(new URL(name, migrationDirectory), 'utf8');
export const oldServices = ['cloud','diary','billing','ai','downloader','downloader2','inventory'];
const quoted = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const insert = (table, values) => `INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.values(values).map(quoted).join(',')});`;

// Synthetic, heterogeneous data. No production database or cryptographic material.
export function legacySeedSql() {
  const statements=[];
  for (const [i,status] of ['active','active','disabled'].entries()) {
    const identity=`fixture-${i}`;
    statements.push(insert('security_identities',{id:identity,display_name:`Fixture ${i}`,status,last_seen_at:i===0?null:'2026-01-01T00:00:00Z'}));
    for (const [j,credentialStatus] of ['active','pending','revoked'].entries()) statements.push(insert('security_credentials',{
      credential_id:`credential-${i}-${j}`,identity_id:identity,public_key:'synthetic-public-key',prf_salt:'synthetic-salt',status:credentialStatus,
      counter:j,transports_json:j===0?'["internal"]':'[]',device_type:j===0?'singleDevice':null,backed_up:j%2,prf_enabled:j%2,
      approved_at:j===0?'2026-01-01T00:00:00Z':null,revoked_at:j===2?'2026-01-02T00:00:00Z':null}));
    for (const service of oldServices) for (const [j,linkStatus] of ['active','pending','disabled'].entries()) {
      const link=`${service}-${i}-${j}`, credential=`credential-${i}-${j}`, account=`account-${i}-${j}`;
      const scopes=service==='cloud'&&j===0?JSON.stringify([{serviceLinkId:link,rootFolderId:42+i}]):null;
      statements.push(insert('security_service_links',{id:link,identity_id:identity,service,service_account_id:account,display_label:`Fixture ${service}`,
        cloud_root_folder_id:service==='cloud'&&j===0?42+i:null,status:linkStatus}));
      statements.push(insert('security_handoffs',{id:`handoff-${link}`,token_hash:`hash-${link}`,identity_id:identity,service_link_id:link,credential_id:credential,
        expires_at:4102444800,consumed_at:j%2?1767225600:null,session_epoch:7,cloud_folder_scopes:scopes}));
      for (const type of ['admin_private_prf','client_private_prf','folder_key_rsa']) statements.push(insert('security_tcloud_key_envelopes',{
        id:`envelope-${type}-${link}`,identity_id:identity,credential_id:credential,service_link_id:link,envelope_type:type,
        public_key_jwk:type==='folder_key_rsa'?null:'{"kty":"RSA"}',encrypted_payload:type==='folder_key_rsa'?null:'encrypted-fixture',
        payload_iv:type==='folder_key_rsa'?null:'fixture-iv',wrapped_key:type==='folder_key_rsa'?'wrapped-fixture':null}));
      statements.push(insert('security_audit_events',{event_id:`audit-${link}`,occurred_at:'2026-01-01T00:00:00.000Z',service,event_type:'session_resume',outcome:'success',
        identity_id:identity,service_account_id:account,service_link_id:link,session_id_hash:`session-${link}`,role:j===0?'owner':null,
        auth_method:j===0?'passkey':'password',source_hash:j===0?'source-fixture':null,details_json:'{"fixture":true,"nested":{"nullable":null}}'}));
      statements.push(insert('security_active_sessions',{session_id_hash:`session-${link}`,identity_id:identity,service,service_link_id:link,service_account_id:account,
        credential_id:j===0?credential:null,role:j===0?'owner':null,auth_method:j===0?'passkey':'password',session_version:'1',passkey_session_epoch:j===0?7:null,
        started_at:'2026-01-01T00:00:00.000Z',last_seen_at:'2026-01-02T00:00:00.000Z',expires_at:4102444800,
        ended_at:j===2?'2026-01-03T00:00:00.000Z':null,end_reason:j===2?'revoked':null,cloud_folder_scopes:scopes}));
    }
  }
  return statements.join('\n');
}

export function snapshot(db, tables) {
  return Object.fromEntries(tables.map(table => [table, {
    rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    columns: db.prepare(`PRAGMA table_info(${table})`).all().map(({cid,...column})=>column).sort((a,b)=>a.name.localeCompare(b.name)),
    foreignKeys: db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    triggers: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name NOT IN ('health_members_only','health_members_only_update') ORDER BY name").all(table),
    indexes: db.prepare(`PRAGMA index_list(${table})`).all().map(({seq,...index})=>({...index,
      columns:db.prepare(`PRAGMA index_info('${index.name}')`).all().map(({cid,...column})=>column),
      sql:(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name)?.sql || '').replaceAll('"','').replace(/\s+/g,' ').trim()
    })).sort((a,b)=>a.name.localeCompare(b.name))
  }]));
}
export const existingTables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'security_%' ORDER BY name").all().map(row=>row.name);
