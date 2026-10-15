import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { auditFixture } from "./audit-history-fixture.mjs";
import { LOGIN_SUCCESS_EVENTS, LOGIN_FAILURE_EVENTS, auditViewFilter } from "../src/security-domain.js";

function assertTotals(db) {
  const counts = db.prepare(`SELECT date(occurred_at,'+9 hours') AS day, COUNT(*) AS event_count,
    SUM(CASE WHEN outcome='success' AND event_type IN (${LOGIN_SUCCESS_EVENTS.map(()=>"?")}) THEN 1 ELSE 0 END) AS login_success,
    SUM(CASE WHEN outcome='failure' AND event_type IN (${LOGIN_FAILURE_EVENTS.map(()=>"?")}) THEN 1 ELSE 0 END) AS login_failure,
    SUM(CASE WHEN outcome='blocked' THEN 1 ELSE 0 END) AS lockouts,
    SUM(CASE WHEN event_type='session_resume' THEN 1 ELSE 0 END) AS session_resume,
    SUM(CASE WHEN event_type IN ('credential_compromise','admin_access') THEN 1 ELSE 0 END) AS critical
    FROM security_audit_events WHERE date(occurred_at,'+9 hours') IS NOT NULL GROUP BY day ORDER BY day`).all(...LOGIN_SUCCESS_EVENTS,...LOGIN_FAILURE_EVENTS);
  assert.deepEqual(db.prepare("SELECT * FROM security_audit_daily ORDER BY day").all(), counts);
}

test("migration backfills original JST counters without changing existing logs", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory).filter(f=>f.endsWith('.sql') && f<'0023').sort()) db.exec(readFileSync(new URL(file,directory),'utf8'));
    let id=0;
    const add=db.prepare("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,auth_method) VALUES(?,?,'security',?,?,'system')");
    for (const time of ['2026-10-13T14:59:59.999Z','2026-10-13T15:00:00.000Z','2026-10-14T14:59:59.999Z','2026-10-14T15:00:00.000Z']) {
      for (const event of [...LOGIN_SUCCESS_EVENTS,...LOGIN_FAILURE_EVENTS,'session_resume','admin_access','credential_compromise','passkey_authentication_success','passkey_authentication_options'])
        for (const outcome of ['success','failure','blocked','info']) add.run(String(++id),time,event,outcome);
    }
    const before=db.prepare('SELECT * FROM security_audit_events ORDER BY event_id').all();
    db.exec(readFileSync(new URL('0023_audit_read_model.sql',directory),'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM security_audit_events ORDER BY event_id').all(),before);
    assertTotals(db);
  } finally { db.close(); }
});

test("derived totals track inserts, retries, minute deduplication, late data, correction, deletion and rollback", () => {
  const f=auditFixture();
  try {
    const first=f.add({occurred_at:'2026-10-14T14:59:59.999Z'});
    const insert=f.db.prepare(`INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,auth_method,session_id_hash)
      VALUES(?,?,'cloud',?,'success','passkey',?) ON CONFLICT DO NOTHING`);
    insert.run(first,'2026-10-14T14:59:59.999Z','passkey_login_success',null);
    insert.run('resume1','2026-10-14T15:00:00.000Z','session_resume','fixture-session');
    insert.run('resume2','2026-10-14T15:00:40.000Z','session_resume','fixture-session');
    f.add({occurred_at:'2026-10-10T01:00:00.000Z',event_type:'bootstrap_auth_failure',outcome:'failure'});
    assertTotals(f.db);
    assert.equal(f.db.prepare("SELECT event_count FROM security_audit_daily WHERE day='2026-10-15'").get().event_count,1);
    f.db.prepare("UPDATE security_audit_events SET occurred_at='2026-10-15T03:00:00Z',event_type='admin_access',outcome='blocked' WHERE event_id=?").run(first);
    assertTotals(f.db);
    f.db.exec("DELETE FROM security_audit_events WHERE occurred_at < '2026-10-11'");
    assertTotals(f.db);
    const before=f.db.prepare('SELECT * FROM security_audit_daily ORDER BY day').all();
    f.db.exec('BEGIN'); f.add(); f.db.exec('ROLLBACK');
    assert.deepEqual(f.db.prepare('SELECT * FROM security_audit_daily ORDER BY day').all(),before);
    f.db.exec('DELETE FROM security_audit_events'); assertTotals(f.db);
  } finally { f.close(); }
});

test("aggregate update failure rolls back the original audit write", () => {
  const f = auditFixture();
  try {
    f.add();
    f.db.exec("CREATE TRIGGER reject_counter BEFORE UPDATE ON security_audit_daily BEGIN SELECT RAISE(ABORT, 'counter unavailable'); END");
    assert.throws(() => f.add(), /counter unavailable/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM security_audit_events").get().count, 1);
    assertTotals(f.db);
  } finally { f.close(); }
});

test("summary pages cap payload at thirty and detail is fetched separately by primary key", async () => {
  const f=auditFixture();
  try {
    const expected=Array.from({length:91},()=>f.add({details_json:'{"note":"detail-only-marker"}',source_hash:'fixture-source',session_id_hash:'fixture-session'}));
    const ids=[]; let cursor;
    do {
      const page=await f.query('summary=true'+(cursor?'&cursor='+cursor:''));
      assert.ok(page.events.length<=30);
      for (const event of page.events) for (const key of ['details_json','source_hash','session_id_hash','target_id','target_type','service_link_id'])
        assert.equal(Object.hasOwn(event,key),false,key);
      assert.doesNotMatch(JSON.stringify(page),/detail-only-marker/);
      ids.push(...page.events.map(e=>e.event_id));cursor=page.nextCursor;
    } while(cursor);
    assert.deepEqual(ids,expected);
    assert.equal((await f.query('summary=true&limit=999999')).events.length,30);
    const event=(await f.detail(ids[0])).event;
    assert.equal(event.details_json,'{"note":"detail-only-marker"}');
    const query=f.queries.at(-1);
    assert.ok(f.db.prepare('EXPLAIN QUERY PLAN '+query.sql).all(...query.values).some(r=>/SEARCH.*event_id=/.test(r.detail)));
    await assert.rejects(f.detail('missing'),{status:404});
  } finally { f.close(); }
});

test("presets use their partial indexes and cursor pages seek from the boundary", async () => {
  const f=auditFixture();
  try {
    for(let i=0;i<100;i++)f.add();
    f.add({event_type:'passkey_login_success',auth_method:'passkey'});
    f.add({event_type:'password_login_failure',outcome:'failure'});
    for(const view of ['password','passkey','attention']){
      await f.query(`summary=true&view=${view}`);
      const q=f.queries.at(-1), plan=f.db.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values);
      assert.ok(plan.some(r=>r.detail.includes(`idx_security_audit_${view}_page`)),JSON.stringify(plan));
      const schema=f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(`idx_security_audit_${view}_page`).sql;
      assert.ok(schema.includes(auditViewFilter(view).clause),'preset/index predicates stay aligned');
    }
    for (const [filter, index] of [['identityId=test-user', 'identity'], ['service=cloud', 'service']]) {
      await f.query(`summary=true&${filter}`);
      const q = f.queries.at(-1), plan = f.db.prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.values);
      assert.ok(plan.some(row => row.detail.includes(`idx_security_audit_${index}_page`)), JSON.stringify(plan));
    }
    const first=await f.query('summary=true');await f.query('summary=true&cursor='+first.nextCursor);
    const q=f.queries.at(-1);
    assert.ok(f.db.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.values).some(r=>/SEARCH.*idx_security_audit_occurred.*occurred_at</.test(r.detail)));
  } finally { f.close(); }
});
