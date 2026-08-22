import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { bootstrapAttemptCutoff } from "../src/security-domain.js";

const directory = fileURLToPath(new URL("../", import.meta.url));
const wrangler = join(directory, "node_modules", "wrangler", "bin", "wrangler.js");
const persistence = mkdtempSync(join(tmpdir(), "troom-security-storage-"));

before(() => run(["d1", "migrations", "apply", "security-db", "--local", "--persist-to", persistence]));
after(() => rmSync(persistence, { recursive: true, force: true }));

test("disabled service links are historical and current NULL-root links are DB-unique", () => {
  sql("INSERT INTO security_identities (id, display_name, status) VALUES ('link_test', 'Link Test', 'active')");
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
    VALUES ('old-link', 'link_test', 'diary', 'main-user', 'old', 'disabled')`);
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
    VALUES ('new-link', 'link_test', 'diary', 'main-user', 'new', 'pending')`);
  const duplicate = run(["d1", "execute", "security-db", "--local", "--persist-to", persistence, "--command",
    `INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
     VALUES ('duplicate-link', 'link_test', 'diary', 'main-user', 'duplicate', 'active')`], false);
  assert.notEqual(duplicate.status, 0);
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_service_links WHERE identity_id = 'link_test'"), 2);
});

test("one invitation can register only one credential even under concurrent inserts", async () => {
  sql("INSERT INTO security_identities (id, display_name, status) VALUES ('invite_test', 'Invite Test', 'invited')");
  sql(`INSERT INTO security_invitations (id, identity_id, token_hash, link_set_hash, expires_at)
    VALUES ('one-invite', 'invite_test', 'one-token-hash', 'one-link-hash', 4102444800)`);
  const statement = (id) => `INSERT INTO security_credentials
    (credential_id, identity_id, public_key, prf_salt, status, registered_via_invitation_id)
    VALUES ('${id}', 'invite_test', 'public', 'salt', 'pending', 'one-invite')`;
  const results = await Promise.all([runAsync(statement("credential-a")), runAsync(statement("credential-b"))]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_credentials WHERE registered_via_invitation_id = 'one-invite'"), 1);
  sql("UPDATE security_invitations SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = 'one-invite'");
  assert.equal(queryText("SELECT status AS value FROM security_invitations WHERE id = 'one-invite'"), "used");
});

test("exclusive account links cannot cross Identities while Cloud folders remain shareable", () => {
  sql("INSERT INTO security_identities (id, display_name, status) VALUES ('exclusive-a', 'A', 'active'), ('exclusive-b', 'B', 'active')");
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
    VALUES ('exclusive-link-a', 'exclusive-a', 'billing', 'exclusive-account', 'Account', 'active')`);
  const duplicate = run(["d1", "execute", "security-db", "--local", "--persist-to", persistence, "--command",
    `INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
     VALUES ('exclusive-link-b', 'exclusive-b', 'billing', 'exclusive-account', 'Account', 'pending')`], false);
  assert.notEqual(duplicate.status, 0);
  sql("UPDATE security_service_links SET status = 'disabled' WHERE id = 'exclusive-link-a'");
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
    VALUES ('exclusive-link-b', 'exclusive-b', 'billing', 'exclusive-account', 'Account', 'active')`);
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
    VALUES ('shared-cloud-a', 'exclusive-a', 'cloud', 'folder-member', 42, 'Shared', 'active'),
           ('shared-cloud-b', 'exclusive-b', 'cloud', 'folder-member', 42, 'Shared', 'active')`);
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_service_links WHERE service = 'cloud' AND cloud_root_folder_id = 42"), 2);
});

test("session resume audit suppresses a duplicate minute and last access is separate from login", () => {
  sql("INSERT INTO security_identities (id, display_name, status, last_login_at) VALUES ('resume-test', 'Resume', 'active', '2026-08-23T00:00:00.000Z')");
  for (const [id, time] of [["resume-a", "2026-08-23T01:02:03.000Z"], ["resume-b", "2026-08-23T01:02:44.000Z"]]) {
    sql(`INSERT OR IGNORE INTO security_audit_events
      (event_id, occurred_at, service, event_type, outcome, identity_id, session_id_hash)
      VALUES ('${id}', '${time}', 'diary', 'session_resume', 'success', 'resume-test', 'hashed-session')`);
  }
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_audit_events WHERE identity_id = 'resume-test' AND event_type = 'session_resume'"), 1);
  sql("UPDATE security_identities SET last_seen_at = '2026-08-23T01:02:44.000Z' WHERE id = 'resume-test'");
  assert.equal(queryText("SELECT last_login_at AS value FROM security_identities WHERE id = 'resume-test'"), "2026-08-23T00:00:00.000Z");
  assert.equal(queryText("SELECT last_seen_at AS value FROM security_identities WHERE id = 'resume-test'"), "2026-08-23T01:02:44.000Z");
});

test("one credential vault serves multiple Cloud links while folder envelopes stay link-specific", () => {
  sql("INSERT INTO security_identities (id, display_name, status) VALUES ('cloud_test', 'Cloud Test', 'active')");
  sql(`INSERT INTO security_credentials (credential_id, identity_id, public_key, prf_salt, status)
    VALUES ('cloud-credential', 'cloud_test', 'public', 'salt', 'active')`);
  sql(`INSERT INTO security_service_links (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
    VALUES ('cloud-2', 'cloud_test', 'cloud', 'folder-member', 2, 'Folder 2', 'active'),
           ('cloud-10', 'cloud_test', 'cloud', 'folder-member', 10, 'Folder 10', 'active')`);
  sql(`INSERT INTO security_tcloud_client_vaults
    (credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
    VALUES ('cloud-credential', 'cloud_test', '{"kty":"RSA"}', 'fingerprint', 'encrypted-private', 'iv')`);
  sql(`INSERT INTO security_tcloud_key_envelopes
    (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
    VALUES ('folder-envelope-2', 'cloud_test', 'cloud-credential', 'cloud-2', 'folder_key_rsa', 'wrapped-2'),
           ('folder-envelope-10', 'cloud_test', 'cloud-credential', 'cloud-10', 'folder_key_rsa', 'wrapped-10')`);
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_tcloud_client_vaults WHERE credential_id = 'cloud-credential'"), 1);
  assert.equal(queryNumber("SELECT COUNT(*) AS value FROM security_tcloud_key_envelopes WHERE credential_id = 'cloud-credential' AND envelope_type = 'folder_key_rsa'"), 2);
});

test("a shared RSA client key decrypts delegated keys for two folders", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  for (const value of [2, 10]) {
    const plain = new Uint8Array(32).fill(value);
    const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, plain);
    const unwrapped = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, wrapped));
    assert.deepEqual(unwrapped, plain);
  }
});

test("bootstrap failure window compares UTC ISO values at the 15-minute boundary", () => {
  const now = Date.parse("2026-08-21T15:05:00.000Z");
  const recent = new Date(now - 14 * 60 * 1000).toISOString();
  const expired = new Date(now - 16 * 60 * 1000).toISOString();
  for (let index = 0; index < 5; index += 1) {
    sql(`INSERT INTO security_audit_events
      (event_id, occurred_at, service, event_type, outcome, auth_method, source_hash)
      VALUES ('recent-${index}', '${recent}', 'security', 'bootstrap_auth_failure', 'failure', 'password', 'recent-source')`);
  }
  sql(`INSERT INTO security_audit_events
    (event_id, occurred_at, service, event_type, outcome, auth_method, source_hash)
    VALUES ('expired-one', '${expired}', 'security', 'bootstrap_auth_failure', 'failure', 'password', 'recent-source')`);
  const cutoff = bootstrapAttemptCutoff(now);
  assert.equal(queryNumber(`SELECT COUNT(*) AS value FROM security_audit_events WHERE source_hash = 'recent-source' AND occurred_at >= '${cutoff}'`), 5);
  assert.equal(queryNumber(`SELECT COUNT(*) AS value FROM security_audit_events WHERE source_hash = 'recent-source' AND occurred_at < '${cutoff}'`), 1);
});

function sql(statement) {
  const result = run(["d1", "execute", "security-db", "--local", "--persist-to", persistence, "--command", statement]);
  return result.stdout;
}

function queryNumber(statement) {
  const match = sql(statement).match(/"value"\s*:\s*(\d+)/);
  assert.ok(match, `No numeric result for ${statement}`);
  return Number(match[1]);
}

function queryText(statement) {
  const match = sql(statement).match(/"value"\s*:\s*"([^"]*)"/);
  assert.ok(match, `No text result for ${statement}`);
  return match[1];
}

function runAsync(statement) {
  return new Promise((resolve) => {
    execFile(process.execPath, [wrangler, "d1", "execute", "security-db", "--local", "--persist-to", persistence, "--command", statement], { cwd: directory }, (error, stdout, stderr) => {
      resolve({ code: error?.code || 0, stdout, stderr });
    });
  });
}

function run(args, requireSuccess = true) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: directory, encoding: "utf8" });
  if (requireSuccess) assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}
