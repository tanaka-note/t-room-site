import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rollingSessionInput } from "../../assets/passkey-rolling.mjs";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {};", shortCircuit: true };
  return next(specifier, context);
} });
const Security = (await import("../src/index.js")).default;
const origin = "https://example.test";

async function fixture({ legacy = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('fixture-user','Fixture','active',1);
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status)
      VALUES('Y3JlZGVudGlhbA','fixture-user','AQI','AQI','active');
    UPDATE security_runtime_state SET passkey_session_epoch=1,switch_observed_enabled=1 WHERE id=1;`);
  const calls = [];
  let beforeCall = null;
  function prepare(sql, args = []) {
    const execute = method => {
      calls.push(sql);
      beforeCall?.(sql, method);
      const statement = db.prepare(sql);
      if (method === "first") return statement.get(...args) || null;
      if (method === "all") return { results: statement.all(...args) };
      return { meta: { changes: Number(statement.run(...args).changes) } };
    };
    return { bind: (...values) => prepare(sql, values), first: async () => execute("first"),
      all: async () => execute("all"), run: async () => execute("run") };
  }
  const env = { DB: { prepare }, PASSKEY_ENABLED: "true", SESSION_SECRET: randomBytes(32).toString("hex") };
  const worker = Object.assign(new Security(), { env, ctx: { waitUntil() {} } });
  const sessions = {}, cookies = [];
  const sign = value => {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url")}`;
  };
  for (const kind of ["admin", "identity"]) {
    const session = { kind, identityId: "fixture-user", credentialId: "Y3JlZGVudGlhbA", authMethod: "passkey",
      passkeySessionEpoch: 1, authenticatedAt: Math.floor(Date.now() / 1000) - 300, exp: Math.floor(Date.now() / 1000) + 3600,
      ...(!legacy ? { sessionId: randomUUID(), rollingSessionVersion: 1 } : {}) };
    sessions[kind] = session;
    cookies.push(`troom_security_${kind}=${sign(session)}`);
    if (!legacy) {
      const input = await rollingSessionInput(env, "security", session, "read");
      session.hash = input.sessionIdHash;
      db.prepare(`INSERT INTO security_active_sessions
        (session_id_hash,identity_id,service,service_account_id,credential_id,role,auth_method,session_version,
         passkey_session_epoch,started_at,last_seen_at,expires_at)
        VALUES(?,?,'security',?,?,?,'passkey','security-1',1,?,?,?)`)
        .run(input.sessionIdHash, session.identityId, input.serviceAccountId, session.credentialId, input.role,
          input.startedAt, input.startedAt, session.exp);
    }
  }
  async function request(path = "audit?view=all", { active = true, cookie = cookies.join("; ") } = {}) {
    return worker.fetch(new Request(`${origin}/security/api/${path}`, { headers: {
      Cookie: cookie, ...(active ? { "X-Troom-Activity": "foreground" } : {})
    } }));
  }
  return { db, env, calls, sessions, sign, request, close: () => db.close(), intercept: fn => { beforeCall = fn; } };
}

test("foreground list requests retain both renewals with at most twelve DB round trips", async () => {
  for (const [path, maximum] of [["audit?view=all", 11], ["identities", 12]]) {
    const f = await fixture();
    try {
      const response = await f.request(path);
      assert.equal(response.status, 200);
      assert.ok(f.calls.length <= maximum, `${path}: ${f.calls.length} DB calls`);
      assert.equal(f.calls.filter(sql => sql.includes("SELECT s.*, i.status")).length, 5, "each read and touch uses its own live snapshot");
      assert.equal(f.calls.filter(sql => sql.includes("INSERT INTO security_runtime_state")).length, 1, "only the API guard initializes runtime");
      const cookies = response.headers.getSetCookie();
      assert.equal(cookies.length, 2);
      for (const cookie of cookies) {
        assert.match(cookie, /Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
        const value = JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url"));
        const initial = f.sessions[value.kind];
        assert.equal(value.sessionId, initial.sessionId);
        assert.equal(value.authenticatedAt, initial.authenticatedAt, "rolling cannot renew privileged reauthentication");
        assert.ok(value.exp >= Math.floor(Date.now() / 1000) + 43199);
        assert.equal(f.db.prepare("SELECT expires_at FROM security_active_sessions WHERE session_id_hash=?").get(initial.hash).expires_at, value.exp);
      }
    } finally { f.close(); }
  }
});

test("background lists validate current authority without extending either session", async () => {
  const f = await fixture();
  try {
    const response = await f.request(undefined, { active: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(f.calls.length, 5);
    for (const session of Object.values(f.sessions))
      assert.equal(f.db.prepare("SELECT expires_at FROM security_active_sessions WHERE session_id_hash=?").get(session.hash).expires_at, session.exp);
  } finally { f.close(); }
});

test("next request immediately rejects changed authority and ledger state", async () => {
  for (const sql of [
    "UPDATE security_credentials SET status='revoked'",
    "UPDATE security_identities SET status='disabled'",
    "UPDATE security_identities SET is_security_admin=0",
    "UPDATE security_runtime_state SET passkey_session_epoch=2",
    "UPDATE security_runtime_state SET switch_observed_enabled=0",
    "UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP",
    "UPDATE security_active_sessions SET expires_at=1",
    "UPDATE security_active_sessions SET session_version='invalid'",
    "UPDATE security_active_sessions SET passkey_session_epoch=2",
    "UPDATE security_active_sessions SET role='identity' WHERE role='security-admin'",
    "UPDATE security_active_sessions SET service='diary'"
  ]) {
    const f = await fixture();
    try {
      assert.equal((await f.request(undefined, { active: false })).status, 200);
      f.db.exec(sql);
      const response = await f.request();
      assert.equal(response.status, sql.includes("switch_observed_enabled") ? 503 : 401, sql);
      assert.equal(response.headers.getSetCookie().length, 0, sql);
    } finally { f.close(); }
  }
});

test("revocation between authorization and response renewal is rechecked", async () => {
  for (const sql of ["UPDATE security_credentials SET status='revoked'", "UPDATE security_runtime_state SET passkey_session_epoch=2"]) {
    const f = await fixture();
    try {
      f.intercept(query => { if (query.includes("FROM security_audit_events")) f.db.exec(sql); });
      const response = await f.request();
      assert.equal(response.status, 200, "preserve the existing already-authorized response behavior");
      assert.equal(response.headers.getSetCookie().length, 0, "renewal must re-read revocation state");
      for (const session of Object.values(f.sessions))
        assert.equal(f.db.prepare("SELECT expires_at FROM security_active_sessions WHERE session_id_hash=?").get(session.hash).expires_at, session.exp);
    } finally { f.close(); }
  }
});

test("logout racing with touch cannot extend or resurrect the session", async () => {
  const f = await fixture();
  try {
    f.intercept(sql => {
      if (sql.includes("UPDATE security_active_sessions SET expires_at = MAX"))
        f.db.prepare("UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP WHERE session_id_hash=?").run(f.sessions.admin.hash);
    });
    const response = await f.request();
    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(f.db.prepare("SELECT expires_at FROM security_active_sessions WHERE session_id_hash=?").get(f.sessions.admin.hash).expires_at, f.sessions.admin.exp);
  } finally { f.close(); }
});

test("global off observation remains permanent until the explicit enable procedure", async () => {
  const f = await fixture();
  try {
    f.env.PASSKEY_ENABLED = "false";
    assert.equal((await f.request()).status, 503);
    assert.equal(f.db.prepare("SELECT passkey_session_epoch FROM security_runtime_state").get().passkey_session_epoch, 2);
    f.env.PASSKEY_ENABLED = "true";
    assert.equal((await f.request()).status, 503);
  } finally { f.close(); }
});

test("tampered, expired and unsupported signed claims never authenticate", async () => {
  const f = await fixture();
  try {
    for (const session of [{ ...f.sessions.admin, exp: 1 }, { ...f.sessions.admin, rollingSessionVersion: 2 },
      { ...f.sessions.admin, kind: "identity" }, { ...f.sessions.admin, passkeySessionEpoch: 2 }]) {
      assert.equal((await f.request(undefined, { cookie: `troom_security_admin=${f.sign(session)}` })).status, 401);
    }
    assert.equal((await f.request(undefined, { cookie: "troom_security_admin=invalid.signature" })).status, 401);
    f.intercept(sql => { if (sql.includes("SELECT s.*, i.status")) throw new Error("Fixture read failure"); });
    assert.equal((await f.request()).status, 401, "no cached authorization fallback on DB failure");
  } finally { f.close(); }
});

test("legacy sessions retain epoch checks and their original fixed expiry", async () => {
  const f = await fixture({ legacy: true });
  try {
    const response = await f.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.getSetCookie().length, 0);
    f.db.exec("UPDATE security_runtime_state SET passkey_session_epoch=2");
    assert.equal((await f.request()).status, 401);
  } finally { f.close(); }
});
