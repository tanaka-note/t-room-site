import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

test("0020 preserves rebuilt tables, constraints and indexes while adding Downloader 2", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const files = fs.readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files.filter((name) => name < "0020_")) db.exec(fs.readFileSync(path.join(directory, file), "utf8"));
    db.exec(`INSERT INTO security_identities (id, display_name, status, is_security_admin) VALUES ('primary-admin','Owner','active',1);
      INSERT INTO security_credentials (credential_id, identity_id, public_key, counter, status, label, prf_salt) VALUES ('credential','primary-admin','key',0,'active','Windows Hello','c2FsdA');
      INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status) VALUES ('d1','primary-admin','downloader','owner','Downloader','active');
      INSERT INTO security_handoffs (id, token_hash, identity_id, service_link_id, credential_id, expires_at, session_epoch) VALUES ('handoff','token','primary-admin','d1','credential',4102444800,7);
      INSERT INTO security_tcloud_key_envelopes (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key) VALUES ('envelope','primary-admin','credential','d1','folder_key_rsa','wrapped');
      INSERT INTO security_audit_events (event_id, occurred_at, service, event_type, outcome, identity_id, service_link_id, details_json) VALUES ('audit','2026-01-01T00:00:00.000Z','downloader','download','success','primary-admin','d1','{"kept":true}');
      INSERT INTO security_active_sessions (session_id_hash, identity_id, service, service_link_id, service_account_id, credential_id, role, auth_method, session_version, started_at, last_seen_at, expires_at) VALUES ('session','primary-admin','downloader','d1','owner','credential','owner','passkey','1','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',4102444800);`);
    const preserved = Object.fromEntries([
      ["security_service_links", "d1"], ["security_handoffs", "handoff"],
      ["security_tcloud_key_envelopes", "envelope"], ["security_audit_events", "audit"],
      ["security_active_sessions", "session"]
    ].map(([table, id]) => {
      const primary = table === "security_active_sessions" ? "session_id_hash" : table === "security_audit_events" ? "event_id" : "id";
      return [table, db.prepare(`SELECT * FROM ${table} WHERE ${primary}=?`).get(id)];
    }));
    db.exec(fs.readFileSync(path.join(directory, "0020_downloader2_service.sql"), "utf8"));
    const links = db.prepare("SELECT service, service_account_id, status FROM security_service_links WHERE identity_id='primary-admin' ORDER BY service").all();
    assert.equal(links.filter((item) => item.service === "downloader2").length, 1);
    assert.equal(links.find((item) => item.service === "downloader2").service_account_id, "owner");
    assert.ok(links.some((item) => item.service === "downloader"), "Downloader 1 link remains");
    for (const [table, before] of Object.entries(preserved)) {
      const primary = table === "security_active_sessions" ? "session_id_hash" : table === "security_audit_events" ? "event_id" : "id";
      const key = before[primary];
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} WHERE ${primary}=?`).get(key), before, `${table} data`);
    }
    const expectedIndexes = [
      "idx_security_service_links_identity", "uq_security_service_links_current", "uq_security_service_links_exclusive_current",
      "idx_security_handoffs_expiry", "idx_security_audit_occurred", "idx_security_audit_filters",
      "uq_security_audit_session_resume_minute", "idx_security_active_sessions_identity", "idx_security_active_sessions_service"
    ];
    const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name));
    for (const name of expectedIndexes) assert.ok(indexes.has(name), name);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.doesNotThrow(() => db.exec("INSERT INTO security_audit_events (event_id, occurred_at, service, event_type, outcome) VALUES ('d2', CURRENT_TIMESTAMP, 'downloader2', 'session_resume', 'success')"));
  } finally { db.close(); }
});
