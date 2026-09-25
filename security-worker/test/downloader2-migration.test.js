import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

test("0020 preserves existing links and adds one owner Downloader 2 link idempotently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const files = fs.readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files.filter((name) => name < "0020_")) db.exec(fs.readFileSync(path.join(directory, file), "utf8"));
    db.exec(`INSERT INTO security_identities (id, display_name, status, is_security_admin) VALUES ('primary-admin','Owner','active',1);
      INSERT INTO security_credentials (credential_id, identity_id, public_key, counter, status, label, prf_salt) VALUES ('credential','primary-admin','key',0,'active','Windows Hello','c2FsdA');
      INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status) VALUES ('d1','primary-admin','downloader','owner','Downloader','active');`);
    db.exec(fs.readFileSync(path.join(directory, "0020_downloader2_service.sql"), "utf8"));
    const links = db.prepare("SELECT service, service_account_id, status FROM security_service_links WHERE identity_id='primary-admin' ORDER BY service").all();
    assert.equal(links.filter((item) => item.service === "downloader2").length, 1);
    assert.equal(links.find((item) => item.service === "downloader2").service_account_id, "owner");
    assert.ok(links.some((item) => item.service === "downloader"), "Downloader 1 link remains");
    assert.doesNotThrow(() => db.exec("INSERT INTO security_audit_events (event_id, occurred_at, service, event_type, outcome) VALUES ('d2', CURRENT_TIMESTAMP, 'downloader2', 'session_resume', 'success')"));
  } finally { db.close(); }
});
