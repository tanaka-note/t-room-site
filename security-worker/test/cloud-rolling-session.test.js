import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as domain from "../src/security-domain.js";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = source.slice(start + 10).search(/\n(?:async )?function /);
  return source.slice(start, end < 0 ? undefined : start + 10 + end);
}
const runtime = new Function("domain", `
  const {normalizeLinkedService, normalizeIdentityId, validCredentialId, passkeySessionStateMatches} = domain;
  const ACTIVE_SESSION_START_EVENTS = new Set(["password_login_success", "passkey_login_success"]);
  ${["cloudPasskeySession", "validatePasskeySession", "normalizeCloudFolderScopes", "validCloudFolderScopes", "activeLinks", "parseJson", "observePasskeyRuntime", "passkeysEnabled", "normalizeId", "normalizeText", "validIso", "validSessionStart", "nowSeconds", "activeSessionStatements", "endActiveSessionsStatement"].map(extract).join("\n")}
  return {cloudPasskeySession, validatePasskeySession, activeSessionStatements, endActiveSessionsStatement};`)(domain);
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(f=>f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL("../migrations/"+name, import.meta.url), "utf8"));
  db.exec(`INSERT INTO security_identities(id, display_name, status) VALUES('user', 'Fixture', 'active');
    INSERT INTO security_credentials(credential_id, identity_id, public_key, prf_salt, status) VALUES('Y3JlZGVudGlhbA','user','AQI','AQI','active');
    INSERT INTO security_service_links(id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES('link','user','cloud','folder-member',7,'Fixture','active');`);
  const env = { PASSKEY_ENABLED:"true", DB:{prepare(sql){let args=[];return {
    bind(...values){args=values;return this}, async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}}}}}}};
  const input = {service:"cloud", sessionIdHash:"A".repeat(43), identityId:"user", credentialId:"Y3JlZGVudGlhbA",
    serviceLinkId:"link", serviceAccountId:"folder-member", cloudRootFolderId:7, sessionEpoch:1,
    role:"member", sessionVersion:"5", startedAt:new Date().toISOString(), expiresAt:Math.floor(Date.now()/1000)+43200};
  return {db, env, input, call:action=>runtime.cloudPasskeySession(env,{...input,action,ttlSeconds:43200})};
}

test("Cloud ledger denies real credential, Identity, link, root, version, epoch and Security session revocation", async () => {
  for (const sql of ["UPDATE security_credentials SET status='revoked'", "UPDATE security_identities SET status='disabled'",
    "UPDATE security_service_links SET status='disabled'", "UPDATE security_service_links SET cloud_root_folder_id=9",
    "UPDATE security_runtime_state SET passkey_session_epoch=2", "UPDATE security_active_sessions SET session_version='6'",
    "UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP", "UPDATE security_active_sessions SET expires_at=1"]) {
    const f=fixture();
    try { assert.equal((await f.call("register")).valid,true); assert.equal((await f.call("read")).valid,true);
      f.db.exec(sql); assert.equal((await f.call("read")).valid,false,sql); assert.equal((await f.call("touch")).valid,false,sql);
    } finally {f.db.close()}
  }
});

test("Cloud logout cannot be resurrected by delayed audit; renewal cannot be shortened by audit", async () => {
  const f=fixture();
  try {
    await f.call("register");
    const event={eventType:"session_resume", outcome:"success", sessionIdHash:f.input.sessionIdHash, service:"cloud",
      identityId:f.input.identityId, credentialId:f.input.credentialId, serviceLinkId:"link", serviceAccountId:"folder-member",
      details:{},role:"member",authMethod:"passkey",sessionVersion:"5",passkeySessionEpoch:1,startedAt:f.input.startedAt,
      occurredAt:new Date().toISOString(),expiresAt:f.input.expiresAt-100};
    for(const stmt of runtime.activeSessionStatements(f.env,event)) await stmt.run();
    assert.equal((await f.call("read")).expiresAt,f.input.expiresAt);
    await f.call("end");
    for(const stmt of runtime.activeSessionStatements(f.env,event)) await stmt.run();
    assert.equal((await f.call("read")).valid,false);
    assert.equal((await f.call("register")).valid,false);
    assert.equal((await runtime.cloudPasskeySession(f.env,{...f.input,service:"diary",action:"read"})).valid,false);
  } finally { f.db.close() }
});

test("explicit Cloud logout stays permanent even when the credential was already disabled", async () => {
  const f=fixture();
  try {
    await f.call("register");
    f.db.exec("UPDATE security_credentials SET status='revoked'");
    assert.equal((await f.call("end")).valid,true);
    f.db.exec("UPDATE security_credentials SET status='active'");
    assert.equal((await f.call("read")).valid,false);
    assert.equal((await f.call("end")).valid,true,"logout is idempotent");
  } finally {f.db.close()}
});

function multiFixture() {
  const f=fixture();
  const scopes=[{serviceLinkId:"link",rootFolderId:7},{serviceLinkId:"second",rootFolderId:9}];
  f.db.exec("INSERT INTO security_service_links(id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status) VALUES('second','user','cloud','folder-member',9,'Second','active')");
  f.db.exec("INSERT INTO security_tcloud_client_vaults (credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv) VALUES('Y3JlZGVudGlhbA','user','{}','fingerprint','cipher','iv')");
  for(const id of ['link','second']) f.db.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv) VALUES(?,?,?,?, 'folder_key_rsa','cipher','iv')").run('envelope-'+id,'user','Y3JlZGVudGlhbA',id);
  f.db.prepare("INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,session_epoch,expires_at,consumed_at,cloud_folder_scopes) VALUES('snapshot','fixture-hash','user','Y3JlZGVudGlhbA','link',1,1,CURRENT_TIMESTAMP,?)").run(JSON.stringify(scopes));
  f.input.cloudScopeId='snapshot';
  return {...f,scopes};
}

test("multi-folder Cloud ledger binds the complete snapshot and denies any revoked scope",async()=>{
  for(const sql of ["UPDATE security_service_links SET status='disabled' WHERE id='second'", "UPDATE security_service_links SET cloud_root_folder_id=11 WHERE id='second'", "DELETE FROM security_tcloud_key_envelopes WHERE service_link_id='second'", "DELETE FROM security_tcloud_client_vaults", "DELETE FROM security_handoffs", "UPDATE security_active_sessions SET cloud_folder_scopes='[]'"]) {
    const f=multiFixture();try {
      assert.equal((await f.call('register')).valid,true);
      assert.equal(f.db.prepare('SELECT cloud_folder_scopes FROM security_active_sessions').get().cloud_folder_scopes,JSON.stringify(f.scopes));
      assert.equal((await f.call('touch')).valid,true);
      f.db.exec(sql);assert.equal((await f.call('read')).valid,false,sql);assert.equal((await f.call('touch')).valid,false,sql);
      assert.equal((await f.call('end')).valid,true,'logout still works after scope revocation');
    }finally{f.db.close()}
  }
  const f=multiFixture();try {
    await f.call('register');
    assert.equal((await runtime.cloudPasskeySession(f.env,{...f.input,cloudScopeId:'missing',action:'read'})).valid,false);
    await runtime.endActiveSessionsStatement(f.env,'service_link_disabled',{serviceLinkId:'second'}).run();
    assert.equal((await f.call('read')).valid,false,'revoking a non-anchor link ends the ledger');
  }finally{f.db.close()}
});
