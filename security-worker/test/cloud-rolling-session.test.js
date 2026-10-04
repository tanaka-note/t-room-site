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
  ${["cloudPasskeySession", "validatePasskeySession", "observePasskeyRuntime", "passkeysEnabled", "normalizeId", "normalizeText", "validIso", "validSessionStart", "nowSeconds", "activeSessionStatements", "endActiveSessionsStatement"].map(extract).join("\n")}
  return {cloudPasskeySession, validatePasskeySession, activeSessionStatements};`)(domain);
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(f=>f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL("../migrations/"+name, import.meta.url), "utf8"));
  db.exec(`INSERT INTO security_identities(id, display_name, status) VALUES('user', 'Fixture', 'active');
    INSERT INTO security_credentials(credential_id, identity_id, public_key, prf_salt, status) VALUES('Y3JlZGVudGlhbA','user','AQI','AQI','active');
    INSERT INTO security_service_links(id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES('link','user','cloud','folder-member',7,'Fixture','active');`);
  const env = { PASSKEY_ENABLED:"true", DB:{prepare(sql){let args=[];return {
    bind(...values){args=values;return this}, async first(){return db.prepare(sql).get(...args)||null},
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
      role:"member",authMethod:"passkey",sessionVersion:"5",passkeySessionEpoch:1,startedAt:f.input.startedAt,
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
