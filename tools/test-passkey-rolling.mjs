import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { trackedPasskeySession } from "../security-worker/src/rolling-sessions.js";
import { rollingSessionInput } from "../assets/passkey-rolling.mjs";
import { ROLLING_SESSION_VERSION } from "../assets/passkey-rolling.mjs";
import { sessionCookieValue, sessionPolicyForAuthMethod } from "../assets/session-policy.mjs";
import { isValidSessionSecret } from "../assets/session-secret.mjs";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}; export const waitUntil=()=>{};", shortCircuit: true };
  if (specifier === "@cloudflare/containers") return { url: "data:text/javascript,export class Container {}; export class ContainerProxy {}; export const getContainer=()=>{throw Error('unexpected Container test call')};", shortCircuit: true };
  return next(specifier, context);
} });
const Security = (await import("../security-worker/src/index.js")).default;
const workers = {};
for (const service of ["diary", "billing", "ai", "downloader", "downloader2"]) workers[service] = (await import(`../${service}-worker/src/index.js`)).default;
const services = ["security", ...Object.keys(workers)];
const credentialId = "Y3JlZGVudGlhbA";
const origin = "https://example.test";
const securitySource = readFileSync(new URL("../security-worker/src/index.js", import.meta.url), "utf8");
function extract(name) {
  const start = securitySource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = securitySource.slice(start + 10).search(/\n(?:async )?function /);
  return securitySource.slice(start, end < 0 ? undefined : start + 10 + end);
}
// Exercise the actual issuer without running an OS WebAuthn prompt.
const issueSecurityCookies = new Function("helpers", `const { trackedPasskeySession, rollingSessionInput, ROLLING_SESSION_VERSION, sessionCookieValue, sessionPolicyForAuthMethod, isValidSessionSecret } = helpers;
  const BASE_PATH='/security', ADMIN_COOKIE='troom_security_admin', IDENTITY_COOKIE='troom_security_identity', encoder=new TextEncoder();
  class HttpError extends Error { constructor(status,message){super(message);this.status=status} }
  const nowSeconds=()=>Math.floor(Date.now()/1000), passkeysEnabled=()=>true;
  const observePasskeyRuntime=async env=>({enabled:true,epoch:Number((await env.DB.prepare('SELECT passkey_session_epoch FROM security_runtime_state').first()).passkey_session_epoch)});
  const hmac=async(value,secret)=>helpers.hmac(value,secret), bytesToBase64Url=bytes=>helpers.encode(bytes);
  ${["passkeyRollingSession", "securitySessionHeaders", "signedCookie"].map(extract).join("\n")}
  return securitySessionHeaders;`)({ trackedPasskeySession, rollingSessionInput, ROLLING_SESSION_VERSION, sessionCookieValue, sessionPolicyForAuthMethod, isValidSessionSecret,
    hmac: (value, secret) => createHmac("sha256", secret).update(value).digest("base64url"), encode: bytes => Buffer.from(bytes).toString("base64url") });

function database(service) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL(`../${service}-worker/migrations/`, import.meta.url);
  if (service !== "downloader2") for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  function prepare(sql, args = []) {
    return { bind: (...values) => prepare(sql, values), first: async () => db.prepare(sql).get(...args) || null,
      all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; } };
  }
  return { db, binding: { prepare, batch: async statements => Promise.all(statements.map(s => s.run())) } };
}
function fixture(service) {
  const securityDb = database("security");
  securityDb.db.exec(`INSERT INTO security_identities(id,display_name,status,is_security_admin) VALUES('primary-admin','Fixture','active',1);
    INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('${credentialId}','primary-admin','AQI','AQI','active')`);
  const account = service === "diary" ? "main-admin" : "owner";
  if (service !== "security") securityDb.db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,display_label,status) VALUES('link','primary-admin',?,?,'Fixture','active')").run(service, account);
  const security = new Security();
  security.env = { DB: securityDb.binding, SESSION_SECRET: randomBytes(32).toString("hex"), PASSKEY_ENABLED: "true" };
  security.ctx = { waitUntil: p => pending.push(p) };
  const local = service === "security" ? securityDb : database(service);
  const env = service === "security" ? security.env : { DB: local.binding, SECURITY: security, SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "1", PASSKEY_ENABLED: "true" };
  const handoffs = new Map(), pending = [];
  if (service !== "security") env.SECURITY = {
    passkeyRollingSession: input => security.passkeyRollingSession(input),
    validatePasskeySession: input => security.validatePasskeySession(input),
    recordAuditEvent: input => security.recordAuditEvent(input),
    getAiBudgetPolicy: async () => ({ monthlyBudgetJpy: 1000, softStopJpy: 1000, hardStopJpy: 1000, reserveEnabled: false }),
    redeemHandoff: async token => { const handoff = handoffs.get(token); handoffs.delete(token); return handoff; }
  };
  const worker = service === "security" ? security : typeof workers[service] === "function" ? Object.assign(new workers[service](), { env, ctx: { waitUntil: p => pending.push(p) } }) : workers[service];
  async function request(path, cookie, { body, active = false } = {}) {
    const req = new Request(`${origin}/${service}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Diary-Request": "1", "X-Billing-Request": "1", ...(cookie ? { Cookie: cookie } : {}), ...(active ? { "X-Troom-Activity": "foreground" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const response = await worker.fetch(req, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending.splice(0));
    return { status: response.status, body: await response.json(), cookie: response.headers.getSetCookie().map(cookie => cookie.split(";", 1)[0]).join("; ") || undefined, headers: response.headers };
  }
  return { env, security, db: local.db, securityDb: securityDb.db, request, async login() {
    if (service === "security") {
      const headers = await issueSecurityCookies(env, new URL(origin), "primary-admin", credentialId, true);
      const cookies = headers.getSetCookie();
      for (const cookie of cookies) assert.match(cookie, /Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
      assert.equal(cookies.length, 2);
      assert.notEqual(payload(cookies[0]).sessionId, payload(cookies[1]).sessionId);
      return cookies.reverse().map(cookie => cookie.split(";", 1)[0]).join("; ");
    }
    const token = crypto.randomUUID();
    handoffs.set(token, { identityId: "primary-admin", credentialId, serviceLinkId: "link", serviceAccountId: account, sessionEpoch: 1 });
    const result = await request("passkey/handoff", null, { body: { handoffToken: token } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.match(result.headers.get("Set-Cookie"), /Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
    return result.cookie;
  }, close() { if (local !== securityDb) local.db.close(); securityDb.db.close(); } };
}
function payload(cookie) { return JSON.parse(Buffer.from(cookie.split("=", 2)[1].split(".")[0], "base64url")); }
function withClock() {
  const OriginalDate = Date; let now = OriginalDate.now();
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  return { advance: seconds => { now += seconds * 1000; }, restore: () => { globalThis.Date = OriginalDate; } };
}
const activityPaths = { security: "audit", diary: "households", billing: "accounts", ai: "characters", downloader: "jobs", downloader2: "pairing/challenge" };
const optionsFor = service => service === "downloader2" ? { body: { deviceChallenge: Buffer.alloc(32, 7).toString("base64url") } } : {};

for (const service of services) test(`${service}: rolling crosses the original twelve hours; idle/status/errors cannot extend; logout stays ended`, async () => {
  const f = fixture(service), clock = withClock();
  try {
    let cookie = await f.login(); const original = payload(cookie);
    clock.advance(3600);
    for (const [path, options] of [[service === "security" ? "status" : "session", { active: true }], [activityPaths[service], optionsFor(service)], ["missing-route", { active: true }]]) {
      const result = await f.request(path, cookie, options);
      assert.equal(result.status, path === "missing-route" ? 404 : 200, path);
      assert.equal(result.headers.get("X-Troom-Session-Expires"), null, path);
      assert.equal(result.cookie, undefined, path);
    }
    clock.advance(36000);
    for (let i = 0; i < 2; i++) {
      const result = await f.request(activityPaths[service], cookie, { ...optionsFor(service), active: true });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.cookie); cookie = result.cookie;
      const renewed = payload(cookie);
      assert.equal(renewed.exp ?? renewed.expiresAt, Math.floor(Date.now() / 1000) + 43200);
      for (const key of ["identityId", "credentialId", "serviceLinkId", "role", "accountVersion", "sessionVersion", "sessionId", "startedAt", "authenticatedAt", "passkeySessionEpoch"]) assert.equal(renewed[key], original[key], key);
      if (!i) clock.advance(39600);
    }
    assert.ok((payload(cookie).exp ?? payload(cookie).expiresAt) > (original.exp ?? original.expiresAt) + 43200);
    const logout = await f.request("logout", cookie, { body: {}, active: true }); assert.equal(logout.status, 200);
    const replay = await f.request(activityPaths[service], cookie, { ...optionsFor(service), active: true }); assert.equal(replay.status, 401);
    assert.equal(replay.cookie, undefined);
  } finally { clock.restore(); f.close(); }
});

for (const service of services) test(`${service}: exact twelve-hour boundary and live revocation fail closed`, async () => {
  for (const change of ["expiry", "credential", "identity", "epoch", "ledger", ...(service !== "security" ? ["link"] : ["admin"])]) {
    const f = fixture(service), clock = withClock();
    try {
      const cookie = await f.login();
      if (change === "expiry") clock.advance(43200);
      if (change === "credential") f.securityDb.exec("UPDATE security_credentials SET status='revoked'");
      if (change === "identity") f.securityDb.exec("UPDATE security_identities SET status='disabled'");
      if (change === "epoch") f.securityDb.exec("UPDATE security_runtime_state SET passkey_session_epoch=2");
      if (change === "ledger") f.securityDb.exec("UPDATE security_active_sessions SET ended_at=CURRENT_TIMESTAMP");
      if (change === "link") f.securityDb.exec("UPDATE security_service_links SET status='disabled'");
      if (change === "admin") f.securityDb.exec("UPDATE security_identities SET is_security_admin=0");
      const result = await f.request(activityPaths[service], cookie, { ...optionsFor(service), active: true });
      assert.equal(result.status, 401, change); assert.equal(result.cookie, undefined, change);
    } finally { clock.restore(); f.close(); }
  }
});

test("Diary foreground household switch keeps the new selection and original session", async () => {
  const f = fixture("diary"), clock = withClock();
  try { const cookie = await f.login(); clock.advance(3600);
    const result = await f.request("households/select", cookie, { body: { householdId: "chiharu-household" }, active: true });
    assert.equal(result.status, 200); assert.equal(payload(result.cookie).activeHouseholdId, "chiharu-household");
    assert.equal(payload(result.cookie).sessionId, payload(cookie).sessionId);
    assert.equal(payload(result.cookie).exp, Math.floor(Date.now() / 1000) + 43200);
  } finally { clock.restore(); f.close(); }
});

test("Security ignores delayed audit expiry and never revives logged-out rolling sessions", async () => {
  for (const service of services) {
    const f = fixture(service), clock = withClock();
    try { const cookie = await f.login(), p = payload(cookie); clock.advance(3600);
      const renewed = await f.request(activityPaths[service], cookie, { ...optionsFor(service), active: true });
      const input = await rollingSessionInput(f.env, service, p, "read");
      const before = f.securityDb.prepare("SELECT * FROM security_active_sessions WHERE session_id_hash=?").get(input.sessionIdHash);
      const event = { ...await rollingSessionInput(f.env, service, p, "read"), eventType: "session_resume", outcome: "success", authMethod: "passkey",
        passkeySessionEpoch: 1, startedAt: before.started_at, expiresAt: before.expires_at - 2000 };
      await f.security.recordAuditEvent(event);
      assert.equal(f.securityDb.prepare("SELECT expires_at FROM security_active_sessions WHERE session_id_hash=?").get(input.sessionIdHash).expires_at, before.expires_at);
      await f.request("logout", renewed.cookie, { body: {} }); await f.security.recordAuditEvent(event);
      assert.equal((await f.request(activityPaths[service], renewed.cookie, { ...optionsFor(service), active: true })).status, 401);
    } finally { clock.restore(); f.close(); }
  }
});

test("Security rolling never grants another five minutes of privileged approval", async () => {
  const f = fixture("security"), clock = withClock();
  try {
    const cookie = await f.login(); clock.advance(301);
    const renewed = await f.request("audit", cookie, { active: true }); assert.equal(renewed.status, 200);
    const operation = await f.request("ai/budgets/primary-admin", renewed.cookie, { body: { monthlyBudgetJpy: 1000 }, active: true });
    assert.equal(operation.status, 428);
    assert.equal(operation.cookie, undefined);
  } finally { clock.restore(); f.close(); }
});

test("legacy cookies retain their original expiry and never opt into rolling on reuse", async () => {
  for (const service of services) {
    const f = fixture(service), clock = withClock();
    try {
      const fresh = await f.login();
      const legacy = fresh.split("; ").map(cookie => {
        const value = payload(cookie); delete value.rollingSessionVersion;
        const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
        return `${cookie.split("=", 1)[0]}=${encoded}.${createHmac("sha256", f.env.SESSION_SECRET).update(encoded).digest("base64url")}`;
      }).join("; ");
      clock.advance(3600);
      const result = await f.request(activityPaths[service], legacy, { ...optionsFor(service), active: true });
      assert.equal(result.status, 200, service); assert.equal(result.cookie, undefined, service);
      clock.advance(39600);
      assert.equal((await f.request(activityPaths[service], legacy, { ...optionsFor(service), active: true })).status, 401, service);
    } finally { clock.restore(); f.close(); }
  }
});

test("rolling cannot adopt a new signed role, account/version/epoch or cross-service binding", async () => {
  for (const service of services) {
    for (const delta of [{ sessionId: "other" }, { passkeySessionEpoch: 2 }, { rollingSessionVersion: 2 }, { serviceLinkId: "other" }, ...(service === "security" ? [{ kind: "other" }] : ["diary", "billing"].includes(service) ? [{ accountVersion: 2 }, { role: "other" }] : [{ sessionVersion: "2" }, { serviceAccountId: "other" }])]) {
      const f = fixture(service);
      try {
        const cookie = await f.login(), value = { ...payload(cookie), ...delta };
        const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
        const altered = `${cookie.split("=", 1)[0]}=${encoded}.${createHmac("sha256", f.env.SESSION_SECRET).update(encoded).digest("base64url")}`;
        const result = await f.request(activityPaths[service], altered, { ...optionsFor(service), active: true });
        assert.equal(result.status, 401, `${service}: ${JSON.stringify(delta)}`); assert.equal(result.cookie, undefined);
      } finally { f.close(); }
    }
  }
});

test("Web activity tagging requires recent trusted foreground activity and stays within the current service", async () => {
  const source = readFileSync(new URL("../security-worker/public/passkey-client.js", import.meta.url), "utf8").split("// Classify activity only")[1];
  const listeners = {}, requests = []; let time = 0;
  const document = { visibilityState: "visible", addEventListener: (type, callback) => { listeners[type] = callback; } };
  const window = { fetch: async (url, init) => { requests.push(init.headers); return new Response("{}"); }, dispatchEvent() {} };
  vm.runInNewContext(source.slice(source.indexOf("(() =>")), { window, document, location: { pathname: "/diary/", href: `${origin}/diary/`, origin }, performance: { now: () => time }, URL, Headers, Request, Response, Event });
  const marked = async url => { await window.fetch(url); return requests.at(-1)?.get("X-Troom-Activity"); };
  assert.equal(await marked("/diary/api/entries"), "foreground");
  time = 60_001; assert.equal(await marked("/diary/api/entries"), null);
  listeners.pointerdown({ isTrusted: false }); assert.equal(await marked("/diary/api/entries"), null);
  listeners.keydown({ isTrusted: true }); assert.equal(await marked("/diary/api/entries"), "foreground");
  document.visibilityState = "hidden"; listeners.wheel({ isTrusted: true }); assert.equal(await marked("/diary/api/entries"), null);
  document.visibilityState = "visible"; time += 60_001; assert.equal(await marked("/diary/api/entries"), null);
  listeners.touchstart({ isTrusted: true }); assert.equal(await marked("/security/api/dashboard"), undefined);
  assert.equal(await marked("https://other.test/diary/api/entries"), undefined);
});
