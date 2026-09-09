import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as domain from "../src/security-domain.js";
import { buildSecurityAuditEvent } from "../../assets/security-audit-worker.js";

// Exercise the production normalizer, SQL upsert and API projection without
// starting Workers, containers, or remote services.
const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
function extract(name) {
  const start = worker.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = worker.slice(start).search(/\n(?:async )?function /);
  return worker.slice(start, end < 0 ? undefined : start + end);
}
const names = ["validIso", "validSessionStart", "normalizeAuditEvent", "normalizeId", "normalizeText", "normalizeSecretText", "sanitizeDetails", "activeSessionStatements", "endActiveSessionsStatement", "publicActiveSession"];
const functions = new Function("domain", `const {normalizeIdentityId, validCredentialId, normalizeUtcTimestamp} = domain;
  const nowSeconds = () => 1788912000;
  const ACTIVE_SESSION_START_EVENTS = new Set(["password_login_success", "passkey_login_success"]);
  ${names.map(extract).join("\n")}
  return { normalizeAuditEvent, activeSessionStatements, publicActiveSession };`)(domain);
const time = "2026-09-08T10:00:00.000Z";
const later = "2026-09-09T10:00:00.000Z";
const epoch = "1970-01-01T00:00:00.000Z";
const base = { eventId: "event", service: "diary", eventType: "session_resume", outcome: "success", identityId: "member", authMethod: "password", sessionIdHash: "session", sessionVersion: "1", expiresAt: 4102444800, occurredAt: later };
const migrations = new URL("../migrations/", import.meta.url);
const repair = readFileSync(new URL("0016_repair_session_start_times.sql", migrations), "utf8");
function fixture() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql") && !name.startsWith("0016")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  const env = { DB: { prepare: (sql) => ({ bind: (...values) => ({ run: () => db.prepare(sql).run(...values) }) }) } };
  return { db, save(input = {}) { for (const stmt of functions.activeSessionStatements(env, functions.normalizeAuditEvent({ ...base, ...input }))) stmt.run(); },
    row: () => db.prepare("SELECT * FROM security_active_sessions WHERE session_id_hash = 'session'").get(),
    audit(extra = {}) {
      const row = { event_id: "login", occurred_at: time, service: "diary", identity_id: "member", session_id_hash: "session", auth_method: "password", event_type: "password_login_success", outcome: "success", ...extra };
      db.prepare(`INSERT INTO security_audit_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    } };
}

test("sender → normalization → storage → API handles missing, null, empty, invalid and valid starts", async () => {
  const f = fixture();
  try {
    for (const value of [undefined, null, "", " ", "invalid", false, 0, epoch, time]) {
      const sent = await buildSecurityAuditEvent(new Request("https://example.com"), { ...base, startedAt: value });
      const event = functions.normalizeAuditEvent({ ...sent, sessionIdHash: "session" });
      assert.equal(event.startedAt, value === time ? time : null);
      f.save(event);
      assert.equal(f.row().started_at, value === time ? time : "");
      assert.equal(functions.publicActiveSession(f.row()).startedAt, value === time ? time : null);
    }
    f.save({ startedAt: later });
    assert.equal(f.row().started_at, time, "resume cannot overwrite a known start");
  } finally { f.db.close(); }
});

test("login occurrence is evidence; a missing occurrence and resumes never invent a start", () => {
  for (const startedAt of [undefined, null, "", "invalid", epoch]) {
    assert.equal(functions.normalizeAuditEvent({ ...base, eventType: "password_login_success", startedAt }).startedAt, later);
    assert.equal(functions.normalizeAuditEvent({ ...base, eventType: "password_login_success", occurredAt: null, startedAt }).startedAt, null);
  }
  assert.notEqual(functions.normalizeAuditEvent({ occurredAt: null }).occurredAt, epoch);
});

test("a genuine start repairs epoch once; expiry, failure and logout rules stay intact", () => {
  const f = fixture();
  try {
    f.save(); f.db.exec(`UPDATE security_active_sessions SET started_at = '${epoch}'`);
    assert.equal(functions.publicActiveSession(f.row()).startedAt, null);
    f.save({ startedAt: time }); assert.equal(f.row().started_at, time);
    f.save({ startedAt: later, expiresAt: 1 }); assert.equal(f.row().expires_at, base.expiresAt);
    f.save({ startedAt: later, outcome: "failure" }); assert.equal(f.row().started_at, time);
    f.save({ eventType: "logout" }); assert.equal(f.row().end_reason, "logout"); assert.ok(f.row().ended_at);
    const auth = worker.slice(worker.indexOf("async function activeSessionState("), worker.indexOf("function publicActiveSession("));
    assert.match(auth, /session\.ended_at IS NULL AND session\.expires_at > \?/);
    assert.doesNotMatch(auth, /started_at/);
  } finally { f.db.close(); }
});

test("migration repairs only unambiguous matching login evidence and is repeatable", () => {
  const cases = [
    ["matching", [{}], time], ["duplicate", [{}, { event_id: "duplicate" }], time],
    ["missing", [], ""], ["other identity", [{ identity_id: "other" }], ""],
    ["other service", [{ service: "cloud" }], ""], ["other session", [{ session_id_hash: "other" }], ""],
    ["other method", [{ auth_method: "passkey" }], ""], ["failed login", [{ outcome: "failure" }], ""],
    ["resume", [{ event_type: "session_resume" }], ""], ["invalid evidence", [{ occurred_at: "invalid" }], ""],
    ["conflicting", [{}, { event_id: "second", occurred_at: later }], ""],
    ["future evidence", [{ occurred_at: "2026-09-10T10:00:00.000Z" }], ""]
  ];
  for (const [label, audits, expected] of cases) {
    const f = fixture();
    try {
      f.save(); f.db.exec(`UPDATE security_active_sessions SET started_at = '${epoch}'`);
      for (const audit of audits) f.audit(audit);
      const before = f.row(); f.db.exec(repair);
      assert.deepEqual({ ...f.row() }, { ...before, started_at: expected }, label);
      f.db.exec(repair); assert.equal(f.row().started_at, expected, `${label}: repeat`);
      assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { f.db.close(); }
  }
});

test("migration preserves valid starts and repairs empty/invalid legacy values without a table rebuild", () => {
  for (const start of [time, "", "invalid"]) {
    const f = fixture();
    try {
      f.save(); f.db.prepare("UPDATE security_active_sessions SET started_at = ?").run(start);
      f.audit({ occurred_at: "2026-09-08T09:00:00.000Z" }); f.db.exec(repair);
      assert.equal(f.row().started_at, start === time ? time : "2026-09-08T09:00:00.000Z");
      assert.equal(f.db.prepare("PRAGMA table_info(security_active_sessions)").all().find((col) => col.name === "started_at").notnull, 1);
    } finally { f.db.close(); }
  }
});

test("all shared audit senders are part of their service build hashes; rolling legacy starts stay unknown", () => {
  const registry = JSON.parse(readFileSync(new URL("../../web-apps.json", import.meta.url), "utf8"));
  for (const id of ["cloud", "diary", "billing"]) assert.ok(registry.apps.find((app) => app.id === id).buildFiles.includes("assets/security-audit-worker.js"), id);
  for (const id of ["diary", "billing"]) {
    const source = readFileSync(new URL(`../../${id}-worker/src/index.js`, import.meta.url), "utf8");
    const expression = source.match(/startedAt: (Object\.hasOwn[^\n]+),/)[1];
    const value = new Function("auth", `return ${expression}`);
    assert.equal(value({ startedAt: null }), null);
    assert.equal(value({ startedAt: time }), time);
    assert.ok(Date.parse(value({})) > 0);
  }
});
