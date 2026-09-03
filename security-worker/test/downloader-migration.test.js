import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(testDirectory, "../migrations");

function applyMigrationsThrough(db, finalMigration) {
  const migrationFiles = fs.readdirSync(migrationsDirectory)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file <= finalMigration)
    .sort();
  for (const migrationFile of migrationFiles) {
    db.exec(fs.readFileSync(path.join(migrationsDirectory, migrationFile), "utf8"));
  }
}

function values(db, sql) {
  return db.prepare(sql).all().map((row) => Object.values(row)[0]);
}

test("0011 preserves production-like Security data while enabling Downloader", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyMigrationsThrough(db, "0010_active_service_sessions.sql");

    db.exec(`
      INSERT INTO security_identities
        (id, display_name, status, is_security_admin, last_login_at, last_seen_at)
      VALUES ('primary-admin', '田中宏知', 'active', 1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');

      INSERT INTO security_credentials
        (credential_id, identity_id, public_key, counter, transports_json, backed_up,
         prf_enabled, prf_salt, status, label, approved_at, last_used_at)
      VALUES ('credential-existing', 'primary-admin', 'public-key', 7, '["internal"]', 1,
              1, 'prf-salt', 'active', 'Windows Hello', '2026-08-01T00:00:00Z',
              '2026-09-02T00:00:00Z');

      INSERT INTO security_service_links
        (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES
        ('link-cloud', 'primary-admin', 'cloud', 'admin', NULL, 'T-Cloud 管理者', 'active'),
        ('link-diary', 'primary-admin', 'diary', 'main-admin', NULL, '日記 管理者', 'active'),
        ('link-billing', 'primary-admin', 'billing', 'owner', NULL, '請求書管理', 'active'),
        ('link-ai', 'primary-admin', 'ai', 'owner', NULL, 'AI Chat By T-ROOM', 'active');

      INSERT INTO security_handoffs
        (id, token_hash, identity_id, service_link_id, credential_id, expires_at, session_epoch)
      VALUES ('handoff-existing', 'handoff-token-hash', 'primary-admin', 'link-cloud',
              'credential-existing', 1800000000, 11);

      INSERT INTO security_tcloud_key_envelopes
        (id, identity_id, credential_id, service_link_id, envelope_type,
         public_key_jwk, encrypted_payload, payload_iv, wrapped_key)
      VALUES ('envelope-existing', 'primary-admin', 'credential-existing', 'link-cloud',
              'admin_private_prf', '{"kty":"RSA"}', 'encrypted', 'iv', 'wrapped');

      INSERT INTO security_audit_events
        (event_id, occurred_at, service, event_type, outcome, identity_id,
         service_account_id, role, auth_method, session_id_hash, details_json,
         service_link_id, service_account_label)
      VALUES ('audit-existing', '2026-09-02T00:00:00Z', 'cloud', 'login', 'success',
              'primary-admin', 'admin', 'admin', 'passkey', 'session-existing', '{}',
              'link-cloud', 'T-Cloud 管理者');

      INSERT INTO security_active_sessions
        (session_id_hash, identity_id, service, service_link_id, service_account_id,
         credential_id, role, auth_method, session_version, passkey_session_epoch,
         started_at, last_seen_at, expires_at)
      VALUES ('session-existing', 'primary-admin', 'cloud', 'link-cloud', 'admin',
              'credential-existing', 'admin', 'passkey', 'v1', 11,
              '2026-09-02T00:00:00Z', '2026-09-02T00:10:00Z', 1800000000);

      INSERT INTO security_ai_budget_policies
        (identity_id, monthly_budget_jpy, soft_stop_jpy, hard_stop_jpy, reserve_enabled)
      VALUES ('primary-admin', 3000, 2700, 2850, 0)
      ON CONFLICT(identity_id) DO UPDATE SET updated_at = updated_at;
    `);

    const before = {
      links: values(db, "SELECT id FROM security_service_links ORDER BY id"),
      handoffs: values(db, "SELECT id FROM security_handoffs ORDER BY id"),
      envelopes: values(db, "SELECT id FROM security_tcloud_key_envelopes ORDER BY id"),
      audits: values(db, "SELECT event_id FROM security_audit_events ORDER BY event_id"),
      sessions: values(db, "SELECT session_id_hash FROM security_active_sessions ORDER BY session_id_hash"),
      credentialCounter: db.prepare("SELECT counter FROM security_credentials WHERE credential_id = 'credential-existing'").get().counter,
      budget: db.prepare("SELECT * FROM security_ai_budget_policies WHERE identity_id = 'primary-admin'").get()
    };

    db.exec(fs.readFileSync(path.join(migrationsDirectory, "0011_downloader_service.sql"), "utf8"));

    assert.deepEqual(
      values(db, "SELECT id FROM security_service_links WHERE service != 'downloader' ORDER BY id"),
      before.links
    );
    assert.deepEqual(values(db, "SELECT id FROM security_handoffs ORDER BY id"), before.handoffs);
    assert.deepEqual(values(db, "SELECT id FROM security_tcloud_key_envelopes ORDER BY id"), before.envelopes);
    assert.deepEqual(values(db, "SELECT event_id FROM security_audit_events ORDER BY event_id"), before.audits);
    assert.deepEqual(values(db, "SELECT session_id_hash FROM security_active_sessions ORDER BY session_id_hash"), before.sessions);
    assert.equal(
      db.prepare("SELECT counter FROM security_credentials WHERE credential_id = 'credential-existing'").get().counter,
      before.credentialCounter
    );
    assert.deepEqual(db.prepare("SELECT * FROM security_ai_budget_policies WHERE identity_id = 'primary-admin'").get(), before.budget);

    const downloaderLink = { ...db.prepare(`
      SELECT identity_id, service, service_account_id, display_label, status
      FROM security_service_links
      WHERE identity_id = 'primary-admin' AND service = 'downloader'
    `).get() };
    assert.deepEqual(downloaderLink, {
      identity_id: "primary-admin",
      service: "downloader",
      service_account_id: "owner",
      display_label: "T-lain Downloader 管理者",
      status: "active"
    });

    const tableSql = Object.fromEntries(db.prepare(`
      SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name IN (
        'security_service_links', 'security_audit_events', 'security_active_sessions'
      )
    `).all().map((row) => [row.name, row.sql]));
    assert.match(tableSql.security_service_links, /'downloader'/);
    assert.match(tableSql.security_audit_events, /'downloader'/);
    assert.match(tableSql.security_active_sessions, /'downloader'/);

    const indexes = new Set(values(db, `
      SELECT name FROM sqlite_schema
      WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
    `));
    for (const index of [
      "idx_security_service_links_identity",
      "idx_security_handoffs_expiry",
      "uq_security_service_links_current",
      "uq_security_service_links_exclusive_current",
      "idx_security_audit_occurred",
      "idx_security_audit_filters",
      "uq_security_audit_session_resume_minute",
      "idx_security_active_sessions_identity",
      "idx_security_active_sessions_service"
    ]) {
      assert.ok(indexes.has(index), `migration must preserve ${index}`);
    }

    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
