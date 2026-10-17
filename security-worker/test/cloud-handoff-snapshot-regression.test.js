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
  return {cloudPasskeySession};`)(domain);

function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
  db.exec(`
    INSERT INTO security_identities(id, display_name, status) VALUES('user', 'Fixture', 'active');
    INSERT INTO security_credentials(credential_id, identity_id, public_key, prf_salt, status)
      VALUES('Y3JlZGVudGlhbA','user','AQI','AQI','active');
    INSERT INTO security_service_links(id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status) VALUES
      ('link','user','cloud','folder-member',7,'Primary','active'),
      ('second','user','cloud','folder-member',9,'Second','active');
    INSERT INTO security_tcloud_client_vaults(credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
      VALUES('Y3JlZGVudGlhbA','user','{}','fingerprint','cipher','iv');
    INSERT INTO security_tcloud_key_envelopes(id, identity_id, credential_id, service_link_id, envelope_type, encrypted_payload, payload_iv) VALUES
      ('envelope-link','user','Y3JlZGVudGlhbA','link','folder_key_rsa','cipher','iv'),
      ('envelope-second','user','Y3JlZGVudGlhbA','second','folder_key_rsa','cipher','iv');
  `);

  const scopes = [
    { serviceLinkId: "link", rootFolderId: 7 },
    { serviceLinkId: "second", rootFolderId: 9 }
  ];
  db.prepare("INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,session_epoch,expires_at,consumed_at,cloud_folder_scopes) VALUES('snapshot','fixture-hash','user','Y3JlZGVudGlhbA','link',1,1,CURRENT_TIMESTAMP,?)")
    .run(JSON.stringify(scopes));

  const env = {
    PASSKEY_ENABLED: "true",
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...values) { args = values; return this; },
          async first() { return db.prepare(sql).get(...args) || null; },
          async all() { return { results: db.prepare(sql).all(...args) }; },
          async run() {
            const result = db.prepare(sql).run(...args);
            return { meta: { changes: Number(result.changes) } };
          }
        };
      }
    }
  };
  const input = {
    service: "cloud",
    sessionIdHash: "A".repeat(43),
    identityId: "user",
    credentialId: "Y3JlZGVudGlhbA",
    serviceLinkId: "link",
    serviceAccountId: "folder-member",
    cloudRootFolderId: 7,
    cloudScopeId: "snapshot",
    sessionEpoch: 1,
    role: "member",
    sessionVersion: "5",
    startedAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 43200
  };
  const call = action => runtime.cloudPasskeySession(env, { ...input, action, ttlSeconds: 43200 });
  return { db, scopes, call };
}

test("rolling read/touch use the active-session snapshot even when the consumed handoff is later changed", async () => {
  const f = fixture();
  try {
    const registered = await f.call("register");
    assert.equal(registered.valid, true);
    assert.deepEqual(registered.folderScopes, f.scopes);
    assert.equal(
      f.db.prepare("SELECT cloud_folder_scopes FROM security_active_sessions").get().cloud_folder_scopes,
      JSON.stringify(f.scopes),
      "registration pins the original approved folder snapshot"
    );

    f.db.exec(`
      INSERT INTO security_service_links(id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
        VALUES('added','user','cloud','folder-member',11,'Added','active');
      INSERT INTO security_tcloud_key_envelopes(id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
        VALUES('envelope-added','user','Y3JlZGVudGlhbA','added','folder_key_rsa','encrypted');
    `);
    const expanded = [...f.scopes, { serviceLinkId: "added", rootFolderId: 11 }];
    f.db.prepare("UPDATE security_handoffs SET cloud_folder_scopes = ? WHERE id = 'snapshot'").run(JSON.stringify(expanded));

    const readExpanded = await f.call("read");
    const touchExpanded = await f.call("touch");
    assert.equal(readExpanded.valid, true);
    assert.equal(touchExpanded.valid, true);
    assert.deepEqual(readExpanded.folderScopes, f.scopes, "a surviving handoff cannot expand an existing session");
    assert.deepEqual(touchExpanded.folderScopes, f.scopes, "touch uses the same pinned active-session snapshot");

    f.db.exec("UPDATE security_handoffs SET cloud_folder_scopes = '[]' WHERE id = 'snapshot'");
    const readEmpty = await f.call("read");
    const touchEmpty = await f.call("touch");
    assert.equal(readEmpty.valid, true, "a stale handoff cannot invalidate an already registered session");
    assert.equal(touchEmpty.valid, true);
    assert.deepEqual(readEmpty.folderScopes, f.scopes);
    assert.deepEqual(touchEmpty.folderScopes, f.scopes);
  } finally {
    f.db.close();
  }
});
