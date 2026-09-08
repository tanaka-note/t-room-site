import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as domain from "../src/security-domain.js";

// Execute the actual read-only API handler against SQLite, without starting any
// Workers, queues or remote bindings. D1 uses the same SQL engine.
const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const source = worker.slice(worker.indexOf("async function listAuditEvents("), worker.indexOf("async function redeemHandoff("));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const dependencies = {
  ...domain, HttpError, normalizeText: (value, limit) => String(value || "").trim().slice(0, limit),
  json: (body) => Response.json(body),
  withUtcTimes: (row) => ({ ...row, occurred_at: domain.normalizeUtcTimestamp(row.occurred_at) })
};
const handler = new Function(...Object.keys(dependencies), `${source}; return listAuditEvents;`)(...Object.values(dependencies));

export function auditFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE security_audit_events (
    event_id TEXT PRIMARY KEY, occurred_at TEXT, event_type TEXT, service TEXT,
    outcome TEXT, auth_method TEXT, identity_id TEXT, service_account_id TEXT,
    service_account_label TEXT, role TEXT, user_agent TEXT, details_json TEXT
  )`);
  let sequence = 0;
  const env = { DB: { prepare: (sql) => ({ bind: (...values) => ({ all: async () => ({ results: db.prepare(sql).all(...values) }) }) }) } };
  return {
    close: () => db.close(),
    add(event = {}) {
      const row = {
        event_id: `event-${String(++sequence).padStart(4, "0")}`, occurred_at: "2026-09-08T13:14:00.000Z",
        event_type: "password_login_success", service: "cloud", outcome: "success", auth_method: "password",
        identity_id: "test-user", service_account_id: "subadmin", service_account_label: "副管理者", role: "subadmin",
        user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0", details_json: "{}", ...event
      };
      db.prepare(`INSERT INTO security_audit_events (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
      return row.event_id;
    },
    async query(search = "") { return (await handler(new URL(`https://example.test/security/api/audit?${search}`), env)).json(); }
  };
}
