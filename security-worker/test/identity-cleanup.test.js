import assert from "node:assert/strict";
import { identityDisplayName } from "../../assets/account-display.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cleanupDisabledIdentities } from "../src/identity-cleanup.js";
import { normalizeUtcTimestamp } from "../src/security-domain.js";

const cutoff = "2026-03-13T00:00:00.000Z";
const old = "2025-01-01T00:00:00.000Z";
test("scheduled cleanup follows successful audit retention cleanup and is included in the published build", () => {
  const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const scheduled = worker.slice(worker.indexOf("async scheduled("), worker.indexOf("async redeemHandoff("));
  assert.match(scheduled, /await this\.env\.DB\.batch\([\s\S]*DELETE FROM security_audit_events[\s\S]*\]\);\s*await cleanupDisabledIdentities/);
  const registry = JSON.parse(readFileSync(new URL("../../web-apps.json", import.meta.url), "utf8"));
  assert.ok(registry.apps.find((app) => app.id === "security").buildFiles.includes("security-worker/src/identity-cleanup.js"));
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  const wrap = (sql, values = []) => ({
    bind: (...values) => wrap(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } })
  });
  const d1 = { prepare: wrap, batch: async (statements) => {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  const insert = (table, row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  const identity = (id, status = "disabled", extra = {}) => insert("security_identities", { id, display_name: `氏名-${id}`, status, updated_at: old, ...extra });
  const credential = (id, status = "revoked", owner = "retired") => insert("security_credentials", { credential_id: id, identity_id: owner, status, public_key: "public", prf_salt: "salt" });
  const link = (id, status = "disabled", service = "diary", owner = "retired") => insert("security_service_links", { id, identity_id: owner, status, service, service_account_id: "member", display_label: "旧連携" });
  const invitation = (id, status = "revoked", extra = {}) => insert("security_invitations", { id, identity_id: "retired", token_hash: id, link_set_hash: "hash", expires_at: 1, status, ...extra });
  const session = (extra = {}) => insert("security_active_sessions", { session_id_hash: "hash", identity_id: "retired", service: "diary", auth_method: "password", session_version: "1", started_at: old, last_seen_at: old, expires_at: 1, ended_at: old, ...extra });
  const audit = (extra = {}) => insert("security_audit_events", { event_id: "event", occurred_at: old, service: "security", event_type: "identity_disabled", outcome: "success", identity_id: "retired", ...extra });
  return { db, d1, insert, identity, credential, link, invitation, session, audit,
    cleanup: () => cleanupDisabledIdentities(d1, cutoff),
    exists: (id = "retired") => Boolean(db.prepare("SELECT 1 FROM security_identities WHERE id = ?").get(id)) };
}

test("only old disabled non-admin identities are deleted, with bounded anonymous audit records", async () => {
  const f = fixture();
  try {
    for (const status of ["active", "invited", "pending_approval"]) f.identity(status, status);
    f.identity("primary-admin", "disabled", { is_security_admin: 0 });
    f.identity("other-admin", "disabled", { is_security_admin: 1 });
    f.identity("recent", "disabled", { updated_at: cutoff });
    f.identity("invalid-date", "disabled", { updated_at: "invalid" });
    f.identity("recent-use", "disabled", { last_seen_at: cutoff });
    for (let index = 0; index < 22; index++) f.identity(`old-${index}`);
    assert.equal((await f.cleanup()).deleted, 20);
    assert.equal((await f.cleanup()).deleted, 2);
    for (const id of ["active", "invited", "pending_approval", "primary-admin", "other-admin", "recent", "invalid-date", "recent-use"]) assert.ok(f.exists(id), id);
    const records = f.db.prepare("SELECT * FROM security_audit_events").all();
    assert.equal(records.length, 22);
    assert.ok(records.every((row) => row.identity_id === null && row.event_type === "disabled_identity_cleanup"));
    assert.doesNotMatch(JSON.stringify(records), /氏名|old-[0-9]/);
  } finally { f.db.close(); }
});

const blockers = {
  "audit even if retention deletion has not run": (f) => f.audit(),
  "audit target": (f) => f.audit({ identity_id: null, target_id: "retired" }),
  "audit actor in details": (f) => f.audit({ identity_id: null, details_json: '{"disabledBy":"retired"}' }),
  "audit link": (f) => { f.link("link"); f.audit({ identity_id: null, service_link_id: "link" }); },
  "active credential": (f) => f.credential("credential", "active"),
  "pending credential": (f) => f.credential("credential", "pending"),
  "active link": (f) => f.link("link", "active"),
  "pending link": (f) => f.link("link", "pending"),
  "external AI history": (f) => f.link("link", "disabled", "ai"),
  "external Downloader history": (f) => f.link("link", "disabled", "downloader"),
  "active invitation even if expired": (f) => f.invitation("invite", "active"),
  "invitation creator reference": (f) => { f.identity("other", "active"); f.invitation("invite", "revoked", { identity_id: "other", created_by_identity_id: "retired" }); },
  "setup session even if completed": (f) => { f.credential("credential"); f.insert("security_setup_sessions", { id: "setup", token_hash: "setup", identity_id: "retired", credential_id: "credential", status: "completed", expires_at: 1 }); },
  "challenge via invitation": (f) => { f.invitation("invite"); f.insert("security_challenges", { id: "challenge", purpose: "invite_registration", challenge_hash: "hash", invitation_id: "invite", expires_at: 4102444800 }); },
  "handoff": (f) => { f.credential("credential"); f.link("link"); f.insert("security_handoffs", { id: "handoff", token_hash: "hash", identity_id: "retired", credential_id: "credential", service_link_id: "link", expires_at: 4102444800 }); },
  "vault": (f) => { f.credential("credential"); f.insert("security_tcloud_client_vaults", { credential_id: "credential", identity_id: "retired", public_key_jwk: "{}", encrypted_payload: "encrypted", payload_iv: "iv" }); },
  "indirect vault": (f) => { f.identity("other", "active"); f.credential("credential"); f.insert("security_tcloud_client_vaults", { credential_id: "credential", identity_id: "other", public_key_jwk: "{}", encrypted_payload: "encrypted", payload_iv: "iv" }); },
  "envelope via link": (f) => { f.identity("other", "active"); f.credential("credential", "revoked", "other"); f.link("link"); f.insert("security_tcloud_key_envelopes", { id: "envelope", credential_id: "credential", identity_id: "other", service_link_id: "link", envelope_type: "folder_key_rsa", wrapped_key: "wrapped" }); },
  "active session": (f) => f.session({ ended_at: null, expires_at: 4102444800 }),
  "recent ended session": (f) => f.session({ ended_at: cutoff }),
  "malformed session date": (f) => f.session({ ended_at: "invalid" }),
  "budget policy": (f) => f.insert("security_ai_budget_policies", { identity_id: "retired", monthly_budget_jpy: 100, soft_stop_jpy: 50, hard_stop_jpy: 90 })
};
for (const [name, block] of Object.entries(blockers)) test(`${name} prevents physical deletion`, async () => {
  const f = fixture();
  try { f.identity("retired"); block(f); assert.equal((await f.cleanup()).deleted, 0); assert.ok(f.exists()); assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0); }
  finally { f.db.close(); }
});

test("expired audit must be removed first; reviewed inactive metadata is then deleted atomically", async () => {
  const f = fixture();
  try {
    f.identity("retired"); f.credential("credential"); f.link("link"); f.invitation("invite"); f.session(); f.audit();
    f.db.exec("UPDATE security_credentials SET registered_via_invitation_id = 'invite' WHERE credential_id = 'credential'");
    assert.equal((await f.cleanup()).deleted, 0);
    f.db.prepare("DELETE FROM security_audit_events WHERE occurred_at < ?").run(cutoff);
    assert.equal((await f.cleanup()).deleted, 1);
    assert.equal(f.exists(), false);
    for (const table of ["security_credentials", "security_service_links", "security_invitations", "security_active_sessions"]) assert.equal(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { f.db.close(); }
});

test("a dependency arriving after candidate selection prevents deletion", async () => {
  const f = fixture();
  try {
    f.identity("retired"); f.session();
    const batch = f.d1.batch;
    f.d1.batch = (statements) => { f.audit(); return batch(statements); };
    assert.equal((await f.cleanup()).deleted, 0);
    assert.ok(f.exists());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_active_sessions").get().count, 1);
  } finally { f.db.close(); }
});

test("audit-write failure rolls back Identity and inactive session removal", async () => {
  const f = fixture();
  try {
    f.identity("retired"); f.session();
    const batch = f.d1.batch;
    f.d1.batch = (statements) => { f.db.exec("CREATE TRIGGER reject_cleanup BEFORE INSERT ON security_audit_events BEGIN SELECT RAISE(ABORT, 'test failure'); END"); return batch(statements); };
    await assert.rejects(f.cleanup(), /test failure/);
    assert.ok(f.exists());
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_active_sessions").get().count, 1);
  } finally { f.db.close(); }
});

test("unreviewed schema fails closed", async () => {
  const f = fixture();
  try { f.identity("retired"); f.db.exec("CREATE TABLE future_identity_data (identity_id TEXT)"); assert.deepEqual(await f.cleanup(), { deleted: 0, skipped: "schema" }); assert.ok(f.exists()); }
  finally { f.db.close(); }
});

test("normal Identity API excludes disabled choices; explicit audit opt-in includes them", async () => {
  const f = fixture();
  try {
    for (const status of ["active", "invited", "pending_approval", "disabled"]) f.identity(status, status);
    const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    const handlerSource = source.slice(source.indexOf("async function listIdentities("), source.indexOf("async function identityDetail("));
    const handler = new Function("json", "normalizeUtcTimestamp", "identityDisplayName", `${handlerSource}; return listIdentities;`)((data) => data, normalizeUtcTimestamp, identityDisplayName);
    const normal = await handler({ DB: f.d1 });
    assert.deepEqual(normal.identities.map((row) => row.id), ["active"]);
    assert.deepEqual(normal.pendingIdentities.map((row) => row.id).sort(), ["invited", "pending_approval"]);
    assert.deepEqual(normal.auditIdentities, []);
    assert.deepEqual((await handler({ DB: f.d1 }, true)).auditIdentities.map((row) => row.id), ["disabled"]);
  } finally { f.db.close(); }
});
