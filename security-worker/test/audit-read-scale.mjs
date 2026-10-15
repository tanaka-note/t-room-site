// Optional, offline scalability regression. No production bindings or credentials.
// node security-worker/test/audit-read-scale.mjs [rows, default 1000000]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { auditFixture } from "./audit-history-fixture.mjs";
import { encodeAuditCursor } from "../src/security-domain.js";

const total = Number(process.argv[2] || 1_000_000);
assert.ok(Number.isInteger(total) && total >= 10_000 && total <= 1_000_000);
const directory = mkdtempSync(join(tmpdir(), "troom-audit-scale-"));
const databasePath = join(directory, "audit.sqlite");
let fixture;
try {
  fixture = auditFixture({ databasePath });
  const { db } = fixture;
  db.exec("PRAGMA cache_size=-8192");
  const insert = db.prepare(`INSERT INTO security_audit_events
    (event_id,occurred_at,event_type,service,outcome,auth_method,identity_id,user_agent,details_json)
    VALUES(?,?,?,?,?,?,'test-user','Mozilla/5.0 Chrome/151.0.0.0',?)`);
  const events = ["password_login_success", "password_login_failure", "passkey_login_success", "passkey_authentication_failure"];
  const start = Date.parse("2026-04-19T00:00:00Z");
  const results = [];
  let seeded = 0;
  for (const count of [...new Set([10_000, Math.min(100_000, total), total])]) {
    const seedStart = performance.now();
    db.exec("BEGIN");
    for (; seeded < count; seeded++) {
      const kind = seeded % 4000;
      insert.run(`scale-${String(seeded).padStart(7, "0")}`,
        new Date(start + Math.floor(seeded * (180 * 86400000 / total))).toISOString(),
        events[kind] || "session_resume", ["cloud", "diary", "billing", "inventory"][seeded % 4],
        kind === 1 || kind === 3 ? "failure" : "success", kind === 0 || kind === 1 ? "password" : "passkey",
        '{"fixture":"detail-only","padding":"' + "x".repeat(256) + '"}');
    }
    db.exec("COMMIT; ANALYZE");
    const timings = {};
    const plans = {};
    const first = await fixture.query("summary=true");
    const middle = db.prepare("SELECT occurred_at,event_id FROM security_audit_events ORDER BY occurred_at DESC,event_id LIMIT 1 OFFSET ?").get(Math.floor(count / 2));
    // OFFSET is only a fixture boundary selector, never part of a measured API query.
    const middleCursor = encodeAuditCursor(middle);
    const cases = {
      latest: "summary=true", next: `summary=true&cursor=${first.nextCursor}`,
      middle: `summary=true&cursor=${middleCursor}`, password: "summary=true&view=password",
      passkey: "summary=true&view=passkey", attention: "summary=true&view=attention",
      identity: "summary=true&identityId=test-user", service: "summary=true&service=cloud"
    };
    for (const [name, query] of Object.entries(cases)) {
      const samples = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const began = performance.now();
        const page = await fixture.query(query);
        samples.push(performance.now() - began);
        assert.ok(page.events.length > 0 && page.events.length <= 30);
        assert.ok(page.events.every(event => !Object.hasOwn(event, "details_json")));
      }
      const q = fixture.queries.at(-1);
      plans[name] = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.values).map(row => row.detail);
      assert.ok(plans[name].some(plan => /(?:SEARCH|SCAN).*USING.*INDEX/.test(plan)));
      timings[name] = Number(samples.sort((a, b) => a - b)[2].toFixed(3));
    }
    const day = new Date(start + Math.floor((count - 1) * (180 * 86400000 / total)) + 9 * 3600000).toISOString().slice(0, 10);
    const overviewSql = "SELECT * FROM security_audit_daily WHERE day=?";
    const began = performance.now();
    assert.ok(db.prepare(overviewSql).get(day));
    timings.overview = Number((performance.now() - began).toFixed(3));
    assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${overviewSql}`).all(day).some(row => /SEARCH.*day=/.test(row.detail)));
    assert.equal(db.prepare("SELECT SUM(event_count) AS count FROM security_audit_daily").get().count, count);
    assert.equal((await fixture.detail(first.events[0].event_id)).event.details_json.includes("detail-only"), true);
    const result = { rows: count, seedSeconds: Number(((performance.now() - seedStart) / 1000).toFixed(2)),
      sizeMiB: Number((statSync(databasePath).size / 1048576).toFixed(1)), medianMs: timings, plans };
    results.push(result);
    console.log(JSON.stringify(result));
    fixture.queries.length = 0;
  }
  console.log(`Offline audit scalability passed at ${total.toLocaleString("en-US")} synthetic rows; timings exclude network and Worker authorization.`);
} finally {
  fixture?.close();
  // These two exact paths were created above; never recursively remove a directory.
  rmSync(databasePath, { force: true });
  rmdirSync(directory);
}
