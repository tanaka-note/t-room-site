import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import * as domain from "../src/security-domain.js";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function extract(name) {
  const pattern = new RegExp(`^(?:async )?function ${name}\\(`, "m");
  const start = source.search(pattern);
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.exec(`INSERT INTO security_identities(id,display_name,status) VALUES('primary-admin','Owner','active'),('member','Member','active');
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('YQ','primary-admin','public','salt','active'),('Yg','member','public','salt','active');
    INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES
    ('admin','primary-admin','cloud','admin',NULL,'Owner','active'),('one','primary-admin','cloud','folder-member',7,'One','active'),('two','primary-admin','cloud','folder-member',9,'Two','active'),('pending','primary-admin','cloud','folder-member',12,'Pending','pending'),('other','member','cloud','folder-member',13,'Other','active');
    INSERT INTO security_tcloud_client_vaults(credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv) VALUES('YQ','primary-admin','{}','fingerprint','cipher','iv'),('Yg','member','{}','other-fingerprint','cipher','iv');
    INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv,wrapped_key) VALUES
    ('a','primary-admin','YQ','admin','admin_private_prf','admin-cipher','iv',NULL),('b','primary-admin','YQ','one','folder_key_rsa',NULL,NULL,'one-wrap'),('c','primary-admin','YQ','two','folder_key_rsa',NULL,NULL,'two-wrap'),('d','member','Yg','other','folder_key_rsa',NULL,NULL,'other-wrap');`);
  function prepare(sql, values = []) {
    const statement = db.prepare(sql);
    return { bind(...args) { return prepare(sql, args); }, async first() { return statement.get(...values) || null; }, async all() { return { results: statement.all(...values) }; }, async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; } };
  }
  const env = { DB: { prepare }, runtime: { enabled: true, epoch: 1 } };
  const context = { ...domain, crypto, console, HANDOFF_TTL_SECONDS: 60,
    HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
    nowSeconds: () => Math.floor(Date.now() / 1000), passkeysEnabled: () => true,
    observePasskeyRuntime: async env => env.runtime,
    requireActiveIdentitySession: async () => ({ identityId: "primary-admin", credentialId: "YQ" }),
    readJson: request => request.json(), publicLink: async (_env, row) => ({ id: row.id, accountId: row.service_account_id }),
    json: value => value, sha256: async value => createHash("sha256").update(value).digest("base64url"),
    randomToken: length => randomBytes(length).toString("base64url"),
    ACTIVE_SESSION_START_EVENTS: new Set(["passkey_login_success", "password_login_success"]),
    validSessionStart: value => value || "" };
  const names = ["createHandoff", "redeemHandoff", "validatePasskeySession", "activeLinks", "tcloudEnvelopeBundle", "normalizeCloudFolderScopes", "validCloudFolderScopes", "normalizeId", "normalizeService", "normalizeText", "normalizeSecretText", "parseJson", "activeSessionStatements", "endActiveSessionsStatement"];
  vm.runInNewContext(names.map(extract).join("\n"), context);
  const handoff = linkId => context.createHandoff(new Request("https://example.test", { method: "POST", body: JSON.stringify({ service: "cloud", linkId }) }), env);
  return { db, env, context, handoff };
}

test("ordinary handoff snapshots only ready member links, keeps admin keys separate and remains one-use", async () => {
  const f = fixture();
  try {
    const result = await f.handoff("cloud-member");
    assert.deepEqual(Object.keys(result.tcloudKey).sort(), ["client_private_prf", "folder_keys_rsa"]);
    assert.deepEqual(Array.from(result.tcloudKey.folder_keys_rsa, item => item.rootFolderId), [7, 9]);
    const scopes = await f.context.redeemHandoff(f.env, result.handoffToken, "cloud");
    assert.deepEqual(Array.from(scopes.folderScopes, item => item.serviceLinkId), ["one", "two"]);
    assert.equal(await f.context.redeemHandoff(f.env, result.handoffToken, "cloud"), null);
    const admin = await f.handoff("admin");
    assert.deepEqual(Object.keys(admin.tcloudKey), ["admin_private_prf"]);
    assert.equal((await f.context.redeemHandoff(f.env, admin.handoffToken, "cloud")).folderScopes, undefined);
    const legacy = await f.handoff("one");
    assert.deepEqual(Object.keys(legacy.tcloudKey).sort(), ["client_private_prf", "folder_key_rsa"]);
    assert.equal((await f.context.redeemHandoff(f.env, legacy.handoffToken, "cloud")).folderScopes, undefined);
  } finally { f.db.close(); }
});

test("a non-anchor revoke stops the complete session and active-session display metadata without resurrecting a relink", async () => {
  const f = fixture();
  try {
    const result = await f.handoff("cloud-member");
    const h = await f.context.redeemHandoff(f.env, result.handoffToken, "cloud");
    const claims = { ...h, service: "cloud", sessionEpoch: h.sessionEpoch };
    assert.equal((await f.context.validatePasskeySession(f.env, claims)).valid, true);
    for (const changes of [{ cloudScopeId: "missing" }, { credentialId: "Yg" }, { sessionEpoch: 2 }, { serviceLinkId: "two", cloudRootFolderId: 9 }, { serviceAccountId: "admin" }]) {
      assert.equal((await f.context.validatePasskeySession(f.env, { ...claims, ...changes })).valid, false);
    }
    f.db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES('added','primary-admin','cloud','folder-member',15,'Added','active'); INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES('added-key','primary-admin','YQ','added','folder_key_rsa','added-wrap');");
    assert.deepEqual(Array.from((await f.context.validatePasskeySession(f.env, claims)).folderScopes, scope => scope.rootFolderId), [7, 9], "live snapshot never expands when another link is approved");
    const event = { sessionIdHash: "one-way-fixture", eventType: "passkey_login_success", outcome: "success", identityId: h.identityId, service: "cloud", serviceLinkId: h.serviceLinkId, serviceAccountId: "folder-member", credentialId: h.credentialId, role: "member", authMethod: "passkey", sessionVersion: "5", passkeySessionEpoch: 1, startedAt: new Date().toISOString(), occurredAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 3600, details: { cloudScopeId: h.cloudScopeId } };
    for (const statement of f.context.activeSessionStatements(f.env, event)) await statement.run();
    assert.equal(JSON.parse(f.db.prepare("SELECT cloud_folder_scopes FROM security_active_sessions").get().cloud_folder_scopes).length, 2);
    f.db.exec("UPDATE security_service_links SET status='disabled' WHERE id='two'");
    assert.equal((await f.context.validatePasskeySession(f.env, claims)).valid, false);
    await f.context.endActiveSessionsStatement(f.env, "service_link_disabled", { serviceLinkId: "two" }).run();
    assert.ok(f.db.prepare("SELECT ended_at FROM security_active_sessions").get().ended_at);
    f.db.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES('replacement','primary-admin','cloud','folder-member',9,'Two','active')");
    assert.equal((await f.context.validatePasskeySession(f.env, claims)).valid, false);
  } finally { f.db.close(); }
});

test("redeem rejects changed or missing delegation and malformed, foreign or privileged scope claims fail closed", async () => {
  const f = fixture();
  try {
    const result = await f.handoff("cloud-member");
    f.db.exec("DELETE FROM security_tcloud_key_envelopes WHERE service_link_id='two'");
    assert.equal(await f.context.redeemHandoff(f.env, result.handoffToken, "cloud"), null);
    const base = { service: "cloud", identityId: "primary-admin", credentialId: "YQ", serviceLinkId: "one", serviceAccountId: "folder-member", cloudRootFolderId: 7, sessionEpoch: 1 };
    for (const folderScopes of [[], [{serviceLinkId:"admin",rootFolderId:7}], [{serviceLinkId:"other",rootFolderId:13}], [{serviceLinkId:"one",rootFolderId:7},{serviceLinkId:"one",rootFolderId:9}]]) assert.equal((await f.context.validatePasskeySession(f.env, {...base,folderScopes})).valid, false);
    assert.equal((await f.context.validatePasskeySession(f.env, {...base,identityId:"member"})).valid, false);
    f.env.runtime = { enabled: false, epoch: 2 };
    assert.equal((await f.context.validatePasskeySession(f.env, base)).valid, false);
  } finally { f.db.close(); }
});
