import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const diary = (await import("../src/index.js")).default;
const Security = (await import("../../security-worker/src/index.js")).default;
function database(service) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL(`../../${service}-worker/migrations/`, import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  function prepare(sql, args = []) {
    return { bind: (...values) => prepare(sql, values), first: async () => db.prepare(sql).get(...args) || null,
      all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      } };
  }
  return { db, binding: { prepare, batch: async values => Promise.all(values.map(value => value.run())) } };
}
const local = database("diary"), central = database("security"), pending = [], checks = [];
const security = new Security();
security.env = { DB: central.binding, SESSION_SECRET: randomBytes(32).toString("hex"), PASSKEY_ENABLED: "true" };
security.ctx = { waitUntil: promise => pending.push(promise) };
central.db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('fixture','Fixture','active',1);
  INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('Y3JlZGVudGlhbA','fixture','AQI','AQI','active');`);
local.db.exec(`INSERT INTO diary_accounts(id,household_id,display_name,login_id,role,must_change_password,can_view_trash,can_permanently_delete,can_view_investment,can_manage_entries)
  VALUES('reader','tanaka-household','Reader','reader@example.test','user',0,0,0,0,0);
  INSERT INTO diary_entries(id,entry_date,title,content,status,household_id) VALUES
  (1,'2026-10-16','田中の日記','本文','published','tanaka-household'),
  (2,'2026-10-16','千晴の日記','別household','published','chiharu-household'),
  (3,'2026-10-15','下書き','未公開','draft','tanaka-household'),
  (4,'2026-10-14','削除済み','非表示','published','tanaka-household');
  UPDATE diary_entries SET deleted_at=CURRENT_TIMESTAMP WHERE id=4;
  INSERT INTO diary_tags(entry_id,tag) VALUES(1,'田中'),(2,'千晴');
  INSERT INTO diary_favorites(account_id,entry_id) VALUES('reader',1);`);
for (const id of ["main-admin", "chiharu-admin", "reader"]) central.db.prepare(`INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status)
  VALUES(?,'fixture','diary',?,'Fixture','active')`).run(`link-${id}`, id);
const tokens = new Map();
const env = { DB: local.binding, SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "1", PASSKEY_ENABLED: "true",
  SECURITY: {
    async redeemHandoff(token, service) { assert.equal(service, "diary"); const value = tokens.get(token); tokens.delete(token); return value; },
    async passkeyRollingSession(input) { checks.push(input.action); return security.passkeyRollingSession(input); },
    validatePasskeySession: input => security.validatePasskeySession(input),
    recordAuditEvent: input => security.recordAuditEvent(input)
  } };
async function request(path, cookie, { body, active = false, userAgent = "fixture" } = {}) {
  const response = await diary.fetch(new Request(`https://fixture.test/diary/api${path}`, {
    method: body ? "POST" : "GET", headers: { Origin: "https://fixture.test", "X-Diary-Request": "1", "Content-Type": "application/json",
      "User-Agent": userAgent, ...(cookie ? { Cookie: cookie } : {}), ...(active ? { "X-Troom-Activity": "foreground" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env, { waitUntil: promise => pending.push(promise) });
  return { response, data: await response.json(), cookie: response.headers.get("Set-Cookie")?.split(";", 1)[0] };
}
async function login(id) {
  const token = randomBytes(16).toString("hex");
  tokens.set(token, { identityId: "fixture", credentialId: "Y3JlZGVudGlhbA", serviceLinkId: `link-${id}`, serviceAccountId: id, sessionEpoch: 1 });
  const result = await request("/passkey/handoff", null, { body: { handoffToken: token } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal((await request("/passkey/handoff", null, { body: { handoffToken: token } })).response.status, 401, "handoff remains single use");
  return result.cookie;
}
function rewrite(cookie, values) {
  const payload = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url"));
  const encoded = Buffer.from(JSON.stringify({ ...payload, ...values })).toString("base64url");
  return `troom_diary_session=${encoded}.${createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url")}`;
}
try {
  assert.equal((await request("/bootstrap")).response.status, 401);
  const reader = await login("reader");
  for (const suffix of ["", "?q=田中", "?month=2026-10&limit=1", "?tag=田中", "?favorite=1", "?dateFrom=2026-10-16&dateTo=2026-10-16"]) {
    checks.length = 0;
    const combined = await request(`/bootstrap${suffix}`, reader);
    assert.equal(combined.response.status, 200, JSON.stringify(combined.data));
    assert.deepEqual(checks, ["read"], "one current Security validation for the entire GET request");
    assert.equal(combined.response.headers.get("Cache-Control"), "no-store");
    assert.equal(combined.cookie, undefined, "background reads never renew");
    for (const [name, path] of [["session", "/session"], ["households", "/households"], ["meta", "/meta"], ["entries", "/entries"]]) {
      assert.deepEqual(combined.data[name], (await request(path + (name === "entries" ? suffix : ""), reader)).data, name);
    }
    assert.ok(combined.data.entries.entries.every(entry => entry.id === 1));
    assert.equal(combined.data.meta.tags.some(tag => tag.value === "千晴"), false);
    assert.equal(combined.data.session.canManageEntries, false);
    assert.equal(combined.data.session.canViewInvestment, false);
  }
  for (const suffix of ["?draft=1", "?trash=1"]) assert.equal((await request(`/bootstrap${suffix}`, reader)).response.status, 403);
  assert.equal((await request("/bootstrap?dateFrom=2026-10-16&dateTo=2026-10-01", reader)).response.status, 400);
  checks.length = 0;
  const foreground = await request("/bootstrap", reader, { active: true });
  assert.deepEqual(checks, ["read", "touch"], "retain foreground renewal without caching validation");
  assert.ok(foreground.cookie);
  const original = JSON.parse(Buffer.from(reader.split("=")[1].split(".")[0], "base64url"));
  const renewed = JSON.parse(Buffer.from(foreground.cookie.split("=")[1].split(".")[0], "base64url"));
  for (const key of ["sessionId", "startedAt", "accountVersion", "version", "serviceLinkId", "passkeySessionEpoch"]) assert.equal(renewed[key], original[key]);
  assert.equal((await request("/bootstrap", reader, { userAgent: "Mozilla/5.0 Line/15.0.0" })).response.status, 403);
  const owner = await login("main-admin");
  const switched = await request("/households/select", owner, { body: { householdId: "chiharu-household" } });
  const other = await request("/bootstrap", switched.cookie);
  assert.equal(other.data.session.activeHouseholdId, "chiharu-household");
  assert.deepEqual(other.data.entries.entries.map(entry => entry.id), [2]);
  assert.equal(other.data.households.households.length, 2);
  assert.equal((await request("/households/select", reader, { body: { householdId: "chiharu-household" } })).response.status, 403);
  for (const values of [{ exp: 1 }, { version: "2" }, { accountVersion: 2 }, { role: "admin" }, { passkeySessionEpoch: 2 }, { serviceLinkId: "other" }, { rollingSessionVersion: 2 }]) {
    assert.equal((await request("/bootstrap", rewrite(reader, values))).response.status, 401, JSON.stringify(values));
  }
  assert.equal((await request("/bootstrap", reader + "tampered")).response.status, 401);
  for (const [table, change] of [["security_credentials", "status='revoked'"], ["security_identities", "status='disabled'"], ["security_service_links", "status='disabled'"]]) {
    central.db.exec(`UPDATE ${table} SET ${change}`);
    assert.equal((await request("/bootstrap", reader)).response.status, 401, table);
    central.db.exec(`UPDATE ${table} SET status='active'`);
  }
  env.PASSKEY_ENABLED = "false";
  assert.equal((await request("/bootstrap", reader)).response.status, 401);
  env.PASSKEY_ENABLED = "true";
  local.db.exec("UPDATE diary_accounts SET session_version=session_version+1 WHERE id='reader'");
  assert.equal((await request("/bootstrap", reader)).response.status, 401);
  local.db.exec("UPDATE diary_accounts SET session_version=session_version-1 WHERE id='reader'");
  assert.equal((await request("/logout", reader, { body: {} })).response.status, 200);
  assert.equal((await request("/bootstrap", reader)).response.status, 401, "logout replay stays revoked");
  await Promise.all(pending);
  assert.ok(central.db.prepare("SELECT COUNT(*) AS count FROM security_audit_events WHERE event_type='session_resume'").get().count > 0);
  console.log("Diary bootstrap: real SQL filters, households, permissions, request-local validation, rolling, revocation, audit and logout passed.");
} finally { await Promise.allSettled(pending); local.db.close(); central.db.close(); }
