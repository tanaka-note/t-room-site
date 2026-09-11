import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
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
    SESSION_SECRET: "local-fixture-session-secret", SESSION_VERSION: "3", PASSKEY_ENABLED: "true", BILLING_PASSWORD_PEPPER: "fixture-pepper",
    DIARY_MAIN_ADMIN_LOGIN_ID: "main@example.test", DIARY_WIFE_ADMIN_LOGIN_ID: "wife@example.test",
    DIARY_MAIN_ADMIN_PASSWORD_HASH: `sha256$${createHash("sha256").update(password).digest("base64url")}`,
    DIARY_WIFE_ADMIN_PASSWORD_HASH: `sha256$${createHash("sha256").update(password).digest("base64url")}`,
    SECURITY: {
      recordAuditEvent: async (event) => audit.push(event),
      validatePasskeySession: async () => ({ valid: validPasskey }),
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
    async request(path, cookie, body) {
      const response = await workers[service].fetch(new Request(`https://example.test/${service}/api/${path}`, {
        method: body ? "POST" : "GET", headers: { Origin: "https://example.test", "Content-Type": "application/json", "X-Diary-Request": "1", "X-Billing-Request": "1", ...(cookie ? { Cookie: cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      }), env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending.splice(0));
      return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || null };
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

for (const target of MANAGED_PASSWORD_ACCOUNTS) test(`${target.service}/${target.accountId}: stop → recover → stop preserves Passkey and rejects every old password cookie`, async () => {
  const f = fixture(target.service);
  try {
    const wrongPassword = await f.login(target.accountId, "wrong-local-password");
    const initial = await f.login(target.accountId); assert.equal(initial.status,200);
    const oldPayload = cookiePayload(initial.cookie); delete oldPayload.passwordSessionEpoch; delete oldPayload.authMethod;
    const legacy = cookieWithPayload(initial.cookie,oldPayload,f.env.SESSION_SECRET);
    assert.equal((await f.request("session",legacy)).body.authenticated,true);
    const passkey = await f.passkey(target.accountId); assert.equal(passkey.status,200);
    assert.equal(cookiePayload(passkey.cookie).passwordSessionEpoch,undefined);
    const baseline = f.accounts();
    await f.change(target.accountId,"disable",0);
    const deriveBits = crypto.subtle.deriveBits;
    let hashCalls = 0;
    crypto.subtle.deriveBits = function (...args) { hashCalls++; return deriveBits.apply(this,args); };
    let blocked;
    try { blocked = await f.login(target.accountId); } finally { crypto.subtle.deriveBits = deriveBits; }
    assert.equal(hashCalls,0,"disabled login skips expensive password hashing");
    assert.equal(blocked.status,401); assert.equal(blocked.cookie,null);
    assert.deepEqual(blocked.body,wrongPassword.body,"same generic response as wrong password");
    assert.equal((await f.request("protected-fixture",initial.cookie)).status,401);
    assert.equal((await f.request("session",initial.cookie)).body.authenticated,false);
    assert.equal((await f.request("session",legacy)).body.authenticated,false);
    assert.equal((await f.request("session",passkey.cookie)).body.authenticated,true);
    assert.equal((await f.passkey(target.accountId)).status,200);
    assert.equal(f.accounts(),baseline,"credentials/active/roles/households/account versions unchanged");
    assert.ok(f.audit.some((event)=>event.details?.reason==="password_auth_disabled"));
    await f.change(target.accountId,"enable",1);
    for(const cookie of [initial.cookie,legacy]) assert.equal((await f.request("session",cookie)).body.authenticated,false);
    const fresh = await f.login(target.accountId); assert.equal(fresh.status,200); assert.equal(cookiePayload(fresh.cookie).passwordSessionEpoch,2);
    const rolled = await f.request("session",fresh.cookie); assert.equal(rolled.body.authenticated,true); assert.equal(cookiePayload(rolled.cookie).passwordSessionEpoch,2);
    assert.equal((await f.request("session",passkey.cookie)).body.authenticated,true);
    await f.change(target.accountId,"disable",2);
    assert.equal((await f.request("session",rolled.cookie)).body.authenticated,false);
    assert.equal((await f.request("session",passkey.cookie)).body.authenticated,true);
    assert.equal(f.accounts(),baseline);
    assert.deepEqual(f.db.prepare("SELECT event_type,password_session_epoch FROM password_auth_policy_audit ORDER BY id").all().map(r=>[r.event_type,r.password_session_epoch]),[["password_auth_disabled",1],["password_auth_enabled",2],["password_auth_disabled",3]]);
    f.invalidatePasskey(); assert.equal((await f.request("session",passkey.cookie)).body.authenticated,false,"existing Passkey revocation still applies");
  } finally { f.close(); }
});

for(const service of ["diary","billing"]) test(`${service}: only the two explicit accounts change; all other accounts retain password login/rolling sessions`,async()=>{
  const f=fixture(service);
  try {
    const baseline=f.accounts();
    for(const t of MANAGED_PASSWORD_ACCOUNTS.filter(t=>t.service===service)) await f.change(t.accountId,"disable",0);
    assert.equal(f.accounts(),baseline);
    const ids=service==="diary"?["main-admin","main-user","future-user"]:["owner","hideaki","yuuka","machiko","future-user"];
    for(const id of ids){
      assert.deepEqual(await readPasswordAuthPolicy(f.env,service,id),{enabled:true,epoch:0});
      const login=await f.login(id);assert.equal(login.status,200,id);
      const p=cookiePayload(login.cookie);delete p.authMethod;delete p.passwordSessionEpoch;
      const legacy=cookieWithPayload(login.cookie,p,f.env.SESSION_SECRET);
      const resumed=await f.request("session",legacy);assert.equal(resumed.body.authenticated,true,id);const rolled=await f.request("session",login.cookie);assert.equal(cookiePayload(rolled.cookie).passwordSessionEpoch,0);
    }
    assert.equal(f.accounts(),baseline);
    assert.deepEqual(f.db.prepare("SELECT service,account_id FROM password_auth_policy ORDER BY account_id").all().map(r=>`${r.service}/${r.account_id}`),MANAGED_PASSWORD_ACCOUNTS.filter(t=>t.service===service).map(t=>`${t.service}/${t.accountId}`).sort());
  } finally{f.close();}
});

test("policy lookups fail closed; Passkey bypasses only password policy; rolling never adopts a new epoch",async()=>{
  const broken={DB:{prepare(){throw Error("D1 unavailable");}}};
  await assert.rejects(validatePasswordSession({accountId:"chiharu"},broken,"billing"));
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

test("operator rejects protected accounts, mismatched names, missing Passkey and stale generations; schema cannot reset cookies",async()=>{
  for(const [s,ids] of [["cloud",["admin","subadmin","folder-member"]],["diary",["main-admin","main-user","future-user","*"]],["billing",["owner","hideaki","yuuka","machiko","future-user","chi%"]],["ai",["owner"]],["downloader",["owner"]]]) for(const id of ids) assert.throws(()=>managedPasswordAccount(s,id));
  const f=fixture("billing"),t=managedPasswordAccount("billing","chiharu");
  try{
    const options={expectName:t.displayName,expectEpoch:0,reason:"test"};
    await assert.rejects(setPasswordAccount(t,"disable",{...options,expectName:"別人"},f.query));
    await assert.rejects(setPasswordAccount(t,"disable",{...options,expectEpoch:3},f.query));
    const noPasskey=async(s,sql)=>s==="security"?[]:f.query(s,sql);
    await assert.rejects(setPasswordAccount(t,"disable",options,noPasskey));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM password_auth_policy").get().n,0);
    await f.change(t.accountId,"disable",0);
    assert.equal((await f.change(t.accountId,"disable",1)).changed,false,"idempotent stop does not advance epoch");
    assert.throws(()=>f.db.exec("DELETE FROM password_auth_policy"));
    assert.throws(()=>f.db.exec("UPDATE password_auth_policy SET password_session_epoch=0"));
    assert.equal(f.db.prepare(updatePasswordPolicySql(t,true,0,"stale")).all().length,0);
    assert.equal(f.db.prepare(changePasswordPolicySql(t,false,0,"stale")).all().length,0);
    const recovered=await setPasswordAccount(t,"enable",{...options,expectEpoch:1},noPasskey);
    assert.equal(recovered.after.passwordAuthEnabled,true,"emergency recovery works without a Passkey");
    f.db.exec("UPDATE billing_accounts SET display_name='different' WHERE id='chiharu'");
    await assert.rejects(inspectPasswordAccount(t,f.query));
  }finally{f.close();}
});

test("migrations contain no initial stops or account/credential writes and only the named services import the policy",()=>{
  for(const service of ["diary","billing"]){
    const sql=schema(service);assert.doesNotMatch(sql,/UPDATE\s+(?:diary_accounts|billing_accounts)|DELETE FROM|INSERT INTO\s+(?:diary_accounts|billing_accounts)/i);
    assert.doesNotMatch(sql,/(?:chiharu|wife-admin|masami)/);
  }
  for(const service of ["cloud","security","ai","downloader"]){
    assert.doesNotMatch(readFileSync(new URL(`../${service}-worker/src/index.js`,import.meta.url),"utf8"),/assets\/password-auth-policy/);
  }
  assert.match(readFileSync(new URL("../security-worker/migrations/0012_cloud_subadmin_password_only.sql",import.meta.url),"utf8"),/Cloud's ID\/password account is unchanged/);
});
