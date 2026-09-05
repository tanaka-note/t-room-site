import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, end);
}
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const DB = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return { async all() { return { results: statement.all(...args) }; }, async first() { return statement.get(...args) || null; } }; } };
  } };
  const context = { PRIMARY_ADMIN_ID: "primary-admin", parseJson: JSON.parse };
  vm.runInNewContext(`${functionSource("activeLinks")}\n${functionSource("tcloudEnvelopeBundle")}\n${functionSource("tcloudSetupStatus")}`, context);
  sqlite.exec(`INSERT INTO security_identities (id, display_name, status) VALUES ('primary-admin','renamed admin','active'), ('other','general member','active');
    INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,prf_enabled,status) VALUES ('a','primary-admin','public','salt',1,'active'),('b','other','public','salt',1,'active');
    INSERT INTO security_service_links (id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES
      ('admin','primary-admin','cloud','admin',NULL,'管理者','active'),
      ('old','primary-admin','cloud','subadmin',NULL,'副管理者','active'),
      ('member','primary-admin','cloud','folder-member',7,'Atsushi','active'),
      ('other-member','other','cloud','folder-member',9,'Other','active');
    INSERT INTO security_tcloud_client_vaults (credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv) VALUES ('a','primary-admin','{}','a-fingerprint','member-cipher','iv'), ('b','other','{}','b-fingerprint','other-cipher','iv');
    INSERT INTO security_tcloud_key_envelopes (id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv,wrapped_key) VALUES
      ('ae','primary-admin','a','admin','admin_private_prf','admin-cipher','iv',NULL),
      ('me','primary-admin','a','member','folder_key_rsa',NULL,NULL,'member-wrap'),
      ('oe','other','b','other-member','folder_key_rsa',NULL,NULL,'other-wrap');`);
  return { sqlite, env: { DB }, context };
}

test("actual candidate SQL returns exactly admin and Atsushi, without combining keys or changing other identities", async () => {
  const { sqlite, env, context } = fixture();
  try {
    const links = await context.activeLinks(env, "primary-admin", "cloud", "a");
    assert.deepEqual(links.map((l) => [l.service_account_id, l.display_label]), [["admin", "管理者"], ["folder-member", "Atsushi"]]);
    assert.deepEqual((await context.activeLinks(env, "other", "cloud", "b")).map((l) => l.id), ["other-member"]);
    assert.equal((await context.activeLinks(env, "primary-admin", "cloud", "b")).length, 0);
    const admin = await context.tcloudEnvelopeBundle(env, "primary-admin", "a", "admin", "admin");
    const member = await context.tcloudEnvelopeBundle(env, "primary-admin", "a", "member", "folder-member");
    assert.deepEqual(Object.keys(admin), ["admin_private_prf"]);
    assert.deepEqual(Object.keys(member).sort(), ["client_private_prf", "folder_key_rsa"]);
    assert.equal(member.client_private_prf.encryptedPayload, "member-cipher");
    sqlite.exec("DELETE FROM security_tcloud_key_envelopes WHERE id='me'");
    assert.deepEqual((await context.activeLinks(env, "primary-admin", "cloud", "a")).map((l) => l.id), ["admin"]);
  } finally { sqlite.close(); }
});

test("setup checks both independent credential key purposes and migration preserves PW accounts and member links", async () => {
  const { sqlite, env, context } = fixture();
  try {
    assert.equal((await context.tcloudSetupStatus(env, "primary-admin", "a", {})).tcloudReady, true);
    sqlite.exec("DELETE FROM security_tcloud_client_vaults WHERE credential_id='a'");
    const partial = await context.tcloudSetupStatus(env, "primary-admin", "a", {});
    assert.equal(partial.adminKeyReady, true);
    assert.equal(partial.clientKeyReady, false);
    assert.equal(partial.needsTCloudSetup, true);
    const migration = readFileSync(new URL("../migrations/0012_cloud_subadmin_password_only.sql", import.meta.url), "utf8");
    sqlite.exec(migration); sqlite.exec(migration);
    assert.equal(sqlite.prepare("SELECT status FROM security_service_links WHERE id='old'").get().status, "disabled");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM security_service_links WHERE status='active'").get().n, 3);
  } finally { sqlite.close(); }
});
