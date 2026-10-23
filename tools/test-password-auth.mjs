import { rollingBinding } from "./fixtures/passkey-rolling-binding.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import test from "node:test";
import { readPasswordAuthPolicy, validatePasswordSession, passwordSessionClaims } from "../assets/password-auth-policy.mjs";
import { MANAGED_PASSWORD_ACCOUNTS, managedPasswordAccount, inspectPasswordAccount, setPasswordAccount, changePasswordPolicySql, updatePasswordPolicySql } from "./password-auth.mjs";
import { createCurrentPasswordRecord } from "../billing-worker/src/auth-security.js";

// Import the full production Workers. Only the Cloudflare base class and remote
// bindings are replaced; login, signatures, session validation and SQL are real.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const workers = { diary: (await import("../diary-worker/src/index.js")).default, billing: (await import("../billing-worker/src/index.js")).default };
const password = "local-fixture-password";
const billingRecord = await createCurrentPasswordRecord(password, "fixture-pepper");
const salt = Buffer.alloc(16, 7);
const diaryHash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 600000, 32, "sha256").toString("base64url")}`;
const schemaFiles = { diary: "0019_password_auth_policy.sql", billing: "0008_password_auth_policy.sql" };
function schema(service) { return readFileSync(new URL(`../${service}-worker/migrations/${schemaFiles[service]}`, import.meta.url), "utf8"); }
function fixture(service) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL(`../${service}-worker/migrations/`, import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql") && file !== schemaFiles[service]).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
  db.exec(schema(service));
  if (service === "diary") {
    db.exec("INSERT INTO diary_accounts (id,household_id,display_name,login_id,role) VALUES ('future-user','tanaka-household','Future','future-user','user')");
    db.prepare("UPDATE diary_accounts SET password_hash = ?, must_change_password = 0").run(diaryHash);
  } else {
    db.exec("INSERT INTO billing_accounts (id,login_id,display_name,role) VALUES ('future-user','future-user','Future','member')");
    db.prepare("UPDATE billing_accounts SET password_salt=?,password_hash=?,password_iterations=?,password_pepper_version=?").run(billingRecord.passwordSalt,billingRecord.passwordHash,billingRecord.passwordIterations,billingRecord.passwordPepperVersion);
  }
  const audit = [], queries = [], pending = [], handoffs = new Map();
  let validPasskey = true;
  function statement(sql, values = []) {
    return { bind: (...args) => statement(sql, args),
      first: async () => { queries.push(sql); return db.prepare(sql).get(...values) || null; },
      all: async () => { queries.push(sql); return { results: db.prepare(sql).all(...values) }; },
      run: async () => { queries.push(sql); const result = db.prepare(sql).run(...values); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
    };
  }
  const env = {
    DB: { prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((s) => s.run())) },
    SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "3", PASSKEY_ENABLED: "true", BILLING_PASSWORD_PEPPER: "fixture-pepper",
    DIARY_MAIN_ADMIN_LOGIN_ID: "main@example.test", DIARY_WIFE_ADMIN_LOGIN_ID: "wife@example.test",
    DIARY_MAIN_ADMIN_PASSWORD_HASH: `sha256$${createHash("sha256").update(password).digest("base64url")}`,
    DIARY_WIFE_ADMIN_PASSWORD_HASH: `sha256$${createHash("sha256").update(password).digest("base64url")}`,
    SECURITY: {
      recordAuditEvent: async (event) => audit.push(event),
      validatePasskeySession: async () => ({ valid: validPasskey }),
      passkeyRollingSession: rollingBinding(() => validPasskey),
      redeemHandoff: async (token, requestedService) => { if (requestedService !== service) return null; const result = handoffs.get(token); handoffs.delete(token); return result; }
    }, SECURITY_AUDIT: { send: async (event) => audit.push(event) }
  };
  const f = {
    db, env, audit, queries, close: () => db.close(), invalidatePasskey: () => { validPasskey = false; },
    accounts: () => JSON.stringify(db.prepare(`SELECT * FROM ${service}_accounts ORDER BY id`).all()),
    query: async (s, sql) => {
      if (s === "security") { const target = MANAGED_PASSWORD_ACCOUNTS.find((t) => t.service === service && sql.includes(`'${t.accountId}'`));
        return [{ service, account_id: target.accountId, display_name: target.displayName, identity_status: "active", link_status: "active", active_credentials: 1 }]; }
      assert.equal(s, service); return db.prepare(sql).all();
    },
    async request(path, cookie, body, headers = {}) {
      const response = await workers[service].fetch(new Request(`https://example.test/${service}/api/${path}`, {
        method: body ? "POST" : "GET", headers: { Origin: "https://example.test", "Content-Type": "application/json", "X-Diary-Request": "1", "X-Billing-Request": "1", ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {})
      }), env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending.splice(0));
      return { status: response.status, body: await response.json(), setCookie: response.headers.get("set-cookie"), cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || null };
    },
    login(accountId, suppliedPassword = password) {
      const loginId = service === "diary" && ["main-admin", "wife-admin"].includes(accountId)
        ? env[accountId === "main-admin" ? "DIARY_MAIN_ADMIN_LOGIN_ID" : "DIARY_WIFE_ADMIN_LOGIN_ID"]
        : db.prepare(`SELECT login_id FROM ${service}_accounts WHERE id=?`).get(accountId).login_id;
      return f.request("login", null, { loginId, password: suppliedPassword });
    },
    passkey(accountId) {
      const token = crypto.randomUUID();
      handoffs.set(token, { identityId: "identity-fixture", credentialId: "credential-fixture", serviceLinkId: `link-${accountId}`, serviceAccountId: accountId, sessionEpoch: 2 });
      return f.request("passkey/handoff", null, { handoffToken: token });
    },
    async change(accountId, action, epoch) { return setPasswordAccount(managedPasswordAccount(service, accountId), action, { expectName: managedPasswordAccount(service,accountId).displayName, expectEpoch: epoch, reason: "local test" }, f.query); }
  };
  return f;
}
function cookiePayload(cookie) { return JSON.parse(Buffer.from(cookie.split("=",2)[1].split(".")[0], "base64url").toString()); }
function cookieWithPayload(cookie, payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return cookie.split("=",1)[0]+"="+encoded+"."+createHmac("sha256",secret).update(encoded).digest("base64url");
}

for (const [service, id] of [["diary", "main-admin"], ["diary", "main-user"], ["diary", "wife-admin"], ["diary", "chiharu-admin"], ["diary", "future-user"], ...["owner", "chiharu", "hideaki", "masami", "yuuka", "machiko", "future-user"].map(id => ["billing", id])]) {
  test(`${service}/${id}: permanently rejects passwords and existing cookies, preserving Passkey access and account data`, async () => {
    const f = fixture(service);
    try {
      if (service === "diary") f.db.exec("UPDATE diary_accounts SET must_change_password = 1");
      const baseline = f.accounts();
      for (const enabled of [null, 1, 0]) {
        if (enabled !== null) f.db.prepare("INSERT INTO password_auth_policy (service,account_id,password_auth_enabled,password_session_epoch,changed_by,reason) VALUES (?,?,?,1,'test','test') ON CONFLICT(service,account_id) DO UPDATE SET password_auth_enabled=excluded.password_auth_enabled,password_session_epoch=password_auth_policy.password_session_epoch+1").run(service,id,enabled);
        assert.equal((await readPasswordAuthPolicy(f.env,service,id)).enabled,false,"DB cannot re-enable retired password auth");
        const beforeQueries=f.queries.length;
        const blocked = await f.login(id);
        assert.equal(blocked.status,401); assert.equal(blocked.cookie,null);
        assert.equal(f.queries.length,beforeQueries,"retired login does not read credentials or mutate counters");
        assert.deepEqual(blocked.body,(await f.login(id,"wrong-local-password")).body);
      }
      assert.ok(f.audit.some(e=>e.details?.reason === "password_auth_disabled"));
      if (service === "billing") {
        const legacyId = await f.request("login",null,{loginId:"sub@a-tanaka.jp",password});
        assert.equal(legacyId.status,401); assert.equal(legacyId.cookie,null);
      }
      const pk = await f.passkey(id); assert.equal(pk.status,200);
      assert.equal(pk.body.role,service === "billing" ? (id === "owner" ? "owner" : "member") : ["main-admin", "wife-admin", "chiharu-admin"].includes(id) ? "admin" : "user");
      for (const authMethod of ["password", undefined]) {
        const payload = { ...cookiePayload(pk.cookie), authMethod, passwordSessionVersion: 1, passwordSessionEpoch: 0 };
        for (const key of ["identityId","credentialId","serviceLinkId","serviceAccountId","passkeySessionEpoch"]) delete payload[key];
        if (!authMethod) delete payload.passwordSessionEpoch;
        const old = cookieWithPayload(pk.cookie,payload,f.env.SESSION_SECRET);
        const resumed = await f.request("session",old,undefined,{"X-Troom-Activity":"foreground"});
        assert.equal(resumed.body.authenticated,false);
        assert.equal(resumed.cookie,null,"rejected cookies are never renewed");
        assert.equal((await f.request(service === "diary" ? "households" : "accounts",old)).status,401);
      }
      const session = await f.request("session",pk.cookie);
      assert.equal(session.body.authenticated,true);
      assert.equal((await f.request(service === "diary" ? "households" : "accounts",pk.cookie)).status,200);
      if (service === "billing") {
        const accounts = await f.request("accounts", pk.cookie);
        if (id !== "owner") assert.deepEqual(accounts.body.accounts.map(a => a.id), [id]);
        const summary = await f.request("summary?month=2026-10&accountId=masami", pk.cookie);
        assert.equal(summary.status, 200);
        assert.equal(summary.body.account.id, id === "owner" ? "masami" : id);
        assert.equal((await f.request("audit-logs", pk.cookie)).status, id === "owner" ? 200 : 403);
        if (id !== "owner") {
          for (const path of ["entries", "settlements"]) assert.equal((await f.request(path, pk.cookie, {})).status, 403);
        }
      }
      if (id === "main-admin") {
        assert.equal(session.body.isGlobalOwner,true);
        const selected = await f.request("households/select",pk.cookie,{householdId:"chiharu-household"});
        assert.equal(selected.status,200);
        assert.equal((await f.request("session",selected.cookie)).body.activeHouseholdId,"chiharu-household");
      }
      if (service === "diary") {
        assert.equal(session.body.mustChangePassword,false,"retired password setup never blocks Passkey business APIs");
        assert.equal((await f.request("password/initial",pk.cookie,{password:"unused-new-password",confirmation:"unused-new-password"})).status,410);
      }
      assert.equal(f.accounts(),baseline,"credentials, flags, roles and versions are unchanged");
      f.invalidatePasskey();
      assert.equal((await f.request("session",pk.cookie)).body.authenticated,false);
    } finally { f.close(); }
  });
}

for (const service of ["diary", "billing"]) test(`${service}: Passkey lifetime and revocation remain independent of retired password records`,async()=>{
  const f=fixture(service),OriginalDate=Date;
  let now=OriginalDate.now();
  globalThis.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  try {
    const pk=await f.passkey(service === "diary" ? "wife-admin" : "chiharu"),payload=cookiePayload(pk.cookie);
    assert.equal(pk.status,200);
    assert.equal(payload.passwordSessionEpoch,undefined);
    assert.equal(payload.passwordSessionVersion,undefined);
    assert.equal((await f.request("session",pk.cookie)).body.authenticated,true);
    now=payload.exp*1000;
    assert.equal((await f.request("session",pk.cookie)).body.authenticated,false);
    assert.equal((await f.request(service === "diary" ? "households" : "accounts",pk.cookie)).status,401);
    const fresh=await f.passkey(service === "diary" ? "wife-admin" : "chiharu");assert.equal(fresh.status,200);
    f.invalidatePasskey();assert.equal((await f.request("session",fresh.cookie)).body.authenticated,false);
  } finally {globalThis.Date=OriginalDate;f.close();}
});

test("policy lookups fail closed; Passkey bypasses only password policy; rolling never adopts a new epoch",async()=>{
  const broken={DB:{prepare(){throw Error("D1 unavailable");}}};
  assert.equal(await validatePasswordSession({accountId:"chiharu"},broken,"billing"),false,"retirement is independent of D1 availability");
  assert.equal(await validatePasswordSession({authMethod:"passkey"},broken,"billing"),true);
  assert.equal(await validatePasswordSession({authMethod:"other"},broken,"billing"),false);
  assert.deepEqual(passwordSessionClaims({authMethod:"passkey",passwordSessionEpoch:3}),{});
  assert.deepEqual(passwordSessionClaims({authMethod:"password",passwordSessionEpoch:0}),{passwordSessionEpoch:0});
});

for (const service of ["diary", "billing"]) test(`${service}: missing policy schema rejects password sessions without disrupting Passkey`, async () => {
  const f = fixture(service), id = service === "diary" ? "chiharu-admin" : "chiharu";
  try {
    const passwordLogin = await f.login(id), passkeyLogin = await f.passkey(id);
    f.db.exec("DROP TABLE password_auth_policy");
    assert.equal((await f.request("session",passwordLogin.cookie)).body.authenticated,false);
    assert.equal((await f.request("protected-fixture",passwordLogin.cookie)).status,401);
    const rejected = await f.login(id); assert.notEqual(rejected.status,200); assert.equal(rejected.cookie,null);
    assert.equal((await f.request("session",passkeyLogin.cookie)).body.authenticated,true);
    assert.equal((await f.passkey(id)).status,200);
  } finally { f.close(); }
});

test("operator cannot re-enable retired billing authentication or write policy SQL", async () => {
  for (const target of MANAGED_PASSWORD_ACCOUNTS) {
    const f = fixture(target.service);
    try {
      const before = f.accounts();
      const inspect = await inspectPasswordAccount(target, f.query);
      assert.equal(inspect.passwordAuthEnabled, false);
      assert.equal(inspect.storedPasswordAuthEnabled, true);
      const noQuery = () => assert.fail("retired operations must reject before any DB access");
      for (const action of ["enable", "disable"]) {
        await assert.rejects(setPasswordAccount(target, action, {}, noQuery), /恒久廃止/);
        assert.throws(() => changePasswordPolicySql(target, action === "enable", 0, "test"), /恒久廃止/);
        assert.throws(() => updatePasswordPolicySql(target, action === "enable", 0, "test"), /恒久廃止/);
      }
      assert.equal(f.accounts(), before);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM password_auth_policy").get().n, 0);
    } finally { f.close(); }
  }
  for (const [service, id] of [["cloud","admin"],["diary","main-admin"],["billing","owner"],["ai","owner"]]) {
    assert.throws(() => managedPasswordAccount(service, id));
  }
});

test("billing: passkey stop never enables passwords or renews rejected cookies", async () => {
  const f = fixture("billing");
  try {
    const pk = await f.passkey("chiharu");
    f.env.PASSKEY_ENABLED = "false";
    assert.equal((await f.login("chiharu")).status, 401);
    assert.equal((await f.passkey("chiharu")).status, 503);
    const resumed = await f.request("session", pk.cookie, undefined, {"X-Troom-Activity":"foreground"});
    assert.equal(resumed.body.authenticated, false);
    assert.equal(resumed.cookie, null);
    assert.equal((await f.request("accounts", pk.cookie)).status, 401);
    f.env.PASSKEY_ENABLED = "true";
    assert.equal((await f.login("chiharu")).status, 401);
    assert.equal((await f.passkey("chiharu")).status, 200);
  } finally { f.close(); }
});

test("migrations contain no initial stops or account/credential writes and only the named services import the policy",()=>{
  for(const service of ["diary","billing"]){
    const sql=schema(service);assert.doesNotMatch(sql,/UPDATE\s+(?:diary_accounts|billing_accounts)|DELETE FROM|INSERT INTO\s+(?:diary_accounts|billing_accounts)/i);
    assert.doesNotMatch(sql,/(?:chiharu|wife-admin|masami|hideaki)/);
  }
  for(const service of ["cloud","security","ai","downloader"]){
    assert.doesNotMatch(readFileSync(new URL(`../${service}-worker/src/index.js`,import.meta.url),"utf8"),/assets\/password-auth-policy/);
  }
  assert.match(readFileSync(new URL("../security-worker/migrations/0012_cloud_subadmin_password_only.sql",import.meta.url),"utf8"),/Cloud's ID\/password account is unchanged/);
});
