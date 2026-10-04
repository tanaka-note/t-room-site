import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import { attachPasskeyLedger, seedMultiFolderHandoff } from "./passkey-ledger-fixture.mjs";
import { context, env, handoff, securityDb } from "./session-fixture.mjs";

const OriginalDate = Date;
let now = Date.now();
const FixedDate = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
globalThis.Date = FixedDate; context.Date = FixedDate;
const decode = cookie => JSON.parse(Buffer.from(cookie.split("=")[1].split(".")[0], "base64url"));
const sign = payload => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return "troom_cloud_session=" + encoded + "." + createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url");
};
async function request(cookie, path, id, activity = true, body = undefined) {
  const response = await context.worker.fetch(new Request("https://example.test/cloud/api" + path, {
    method: body ? "POST" : "GET", headers: { Cookie: cookie, Origin: "https://example.test",
      "Content-Type": "application/json", ...(id ? { "X-TCloud-Session": id } : {}),
      ...(activity ? { "X-TCloud-Activity": "foreground" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {} });
  const setCookie = response.headers.get("set-cookie");
  return { status: response.status, body: await response.json(), setCookie, cookie: setCookie?.split(";")[0],
    expires: Number(response.headers.get("X-TCloud-Session-Expires")) };
}
try {
  for (const role of ["admin", "folder-member"]) {
    const login = await handoff(role);
    const payload = decode(login.cookie), id = login.body.sessionCacheId;
    assert.equal(payload.exp, Math.floor(now / 1000) + 43200);
    const initial = await request(login.cookie, "/session", id);
    assert.equal(initial.body.sessionCacheId, id);
    assert.equal(initial.setCookie, null, "session checks do not roll or reissue");
    now += 10 * 3600 * 1000;
    for (const [path, activity] of [["/session", true], ["/crypto-config", true], ["/items", false], ["/not-found", true]]) {
      assert.equal((await request(login.cookie, path, id, activity)).setCookie, null, path);
    }
    assert.equal((await request(login.cookie, "/items", "wrong-session")).status, 419);
    const rolling = await request(login.cookie, "/items", id);
    assert.equal(rolling.status, 200);
    assert.match(rolling.setCookie, /Max-Age=43200; HttpOnly; SameSite=Strict; Secure/);
    assert.equal(rolling.expires, Math.floor(now / 1000) + 43200);
    const renewed = decode(rolling.cookie);
    const tampered = rolling.cookie.slice(0,-1) + (rolling.cookie.endsWith("A") ? "B" : "A");
    assert.equal((await request(tampered, "/session", id)).body.authenticated, false, "signature failure cannot use any device cache");
    assert.equal(renewed.sessionId, id);
    assert.equal(renewed.startedAt, payload.startedAt);
    assert.equal(renewed.identityId, payload.identityId);
    now = (payload.exp + 1) * 1000;
    assert.equal((await request(rolling.cookie, "/session", id)).body.authenticated, true);
    // Every server binding is checked before a cache can be considered.
    for (const extra of [{credentialId:"other"},{identityId:"other"},{serviceLinkId:"other"},
      {role:role === "admin" ? "member":"admin"},{rootFolderId:99},{version:"other"},{passkeySessionEpoch:99},{sessionId:"other"}]) {
      assert.equal((await request(sign({...renewed,...extra}), "/session", null)).body.authenticated, false);
    }
    const validate = env.SECURITY.validatePasskeySession;
    for (const condition of ["credential revoke", "link revoke", "identity disable", "epoch revoke"]) {
      env.SECURITY.validatePasskeySession = async () => ({valid:false});
      assert.equal((await request(rolling.cookie, "/session", id)).body.authenticated, false, condition);
      assert.equal((await request(rolling.cookie, "/items", id)).status, 401, condition);
    }
    env.SECURITY.validatePasskeySession = validate;
    env.SECURITY.validatePasskeySession = async () => ({valid:false});
    assert.equal((await request(rolling.cookie, "/logout", id, false, {})).status, 200);
    env.SECURITY.validatePasskeySession = validate;
    assert.equal((await request(rolling.cookie, "/session", id)).body.authenticated, false, "copied token is revoked after logout");
    assert.equal((await request(rolling.cookie, "/items", id)).status, 401);
    const second = await handoff(role);
    now = decode(second.cookie).exp * 1000;
    assert.equal((await request(second.cookie, "/session", second.body.sessionCacheId)).body.authenticated, false);
    assert.equal((await request(second.cookie, "/items", second.body.sessionCacheId)).status, 401);
    assert.ok(securityDb.prepare("SELECT count(*) n FROM security_active_sessions WHERE ended_at IS NOT NULL").get().n > 0);
  }
  const rpc=env.SECURITY.cloudPasskeySession;
  delete env.SECURITY.cloudPasskeySession;
  const unavailable=await request(null,"/passkey/handoff",null,false,{handoffToken:"fixture"});
  assert.equal(unavailable.status,503);assert.equal(unavailable.setCookie,null,"missing Security RPC cannot issue a session");
  env.SECURITY.cloudPasskeySession=rpc;
  const active=await handoff("admin");
  env.SECURITY.cloudPasskeySession=async()=>{throw new Error("fixture outage")};
  assert.equal((await request(active.cookie,"/session",active.body.sessionCacheId)).body.authenticated,false);
  assert.equal((await request(active.cookie,"/items",active.body.sessionCacheId)).status,401);
  assert.equal((await request(active.cookie,"/logout",active.body.sessionCacheId,false,{})).status,503);
  env.SECURITY.cloudPasskeySession=rpc;
  console.log("PASS Cloud rolling: foreground success, fixed ID/start, persistent Cookie, inactivity timeout, logout replay, binding/revoke rejection");
} finally { globalThis.Date = OriginalDate; context.Date = OriginalDate; }

// Both actual Workers' authorization functions, signed Cookies and real SQL.
const originalSecurity = { ...env.SECURITY };
globalThis.Date = FixedDate; context.Date = FixedDate;
try {
  for (const revoke of [null, "link", "envelope", "vault", "credential", "identity", "epoch", "version", "logout"]) {
    now=OriginalDate.now();const started=now;
    const ledger=attachPasskeyLedger(env,{realValidation:true});
    try {
      const scopes=seedMultiFolderHandoff(ledger);
      const login=await request(null,"/passkey/handoff",null,false,{handoffToken:"cloud-member"});
      assert.equal(login.status,200,JSON.stringify(login.body));
      let cookie=login.cookie;const initial=decode(cookie), id=initial.sessionId;
      const stored=()=>ledger.prepare("SELECT * FROM security_active_sessions").get();
      assert.equal(stored().cloud_folder_scopes,JSON.stringify(scopes));
      for(const hour of [10,20]) {
        now=started+hour*3600000;
        const response=await request(cookie,"/items",id);
        assert.equal(response.status,200);cookie=response.cookie;
        assert.equal(response.expires,Math.floor(now/1000)+43200);
        assert.equal(decode(cookie).sessionId,id);assert.equal(decode(cookie).startedAt,initial.startedAt);
      }
      now=started+26*3600000;
      // Exactly the scheduled cleanup predicate, after more than a day.
      ledger.prepare("DELETE FROM security_handoffs WHERE expires_at < ?").run(Math.floor(now/1000)-86400);
      assert.equal(ledger.prepare("SELECT count(*) n FROM security_handoffs").get().n,0);
      const session=await request(cookie,"/session",id);
      assert.equal(session.body.authenticated,true);assert.deepEqual(session.body.folderScopes,scopes);
      assert.equal(session.body.sessionCacheId,id);assert.equal(session.setCookie,null);
      const items=await request(cookie,"/items",id);assert.equal(items.status,200);cookie=items.cookie;
      assert.deepEqual(items.body.folders.map(f=>f.id),[7,9]);
      assert.equal(decode(cookie).startedAt,initial.startedAt);assert.equal(stored().cloud_folder_scopes,JSON.stringify(scopes));
      // A newly ready link never expands the existing active-session snapshot.
      ledger.exec("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES('added','primary-admin','cloud','folder-member',101,'Added','active'); INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES('added-envelope','primary-admin','Y3JlZGVudGlhbA','added','folder_key_rsa','encrypted-fixture')");
      assert.deepEqual((await request(cookie,"/session",id)).body.folderScopes,scopes);
      const rpcInput={service:"cloud",action:"touch",sessionIdHash:stored().session_id_hash,identityId:initial.identityId,credentialId:initial.credentialId,serviceLinkId:initial.serviceLinkId,serviceAccountId:initial.serviceAccountId,role:initial.role,cloudRootFolderId:initial.rootFolderId,cloudScopeId:initial.cloudScopeId,sessionVersion:initial.version,sessionEpoch:initial.passkeySessionEpoch,ttlSeconds:43200};
      const sql={link:"UPDATE security_service_links SET status='disabled' WHERE id='primary-admin-second'",envelope:"DELETE FROM security_tcloud_key_envelopes WHERE service_link_id='primary-admin-second'",vault:"DELETE FROM security_tcloud_client_vaults",credential:"UPDATE security_credentials SET status='revoked'",identity:"UPDATE security_identities SET status='disabled'",epoch:"UPDATE security_runtime_state SET passkey_session_epoch=2"};
      if(sql[revoke])ledger.exec(sql[revoke]);
      if(revoke==="version")env.SESSION_VERSION="changed";
      if(revoke==="logout")assert.equal((await request(cookie,"/logout",id,false,{})).status,200);
      if(revoke) {
        assert.equal((await request(cookie,"/session",id)).body.authenticated,false,revoke);
        assert.equal((await request(cookie,"/items",id)).status,401,revoke);
        if(revoke==="version")rpcInput.sessionVersion="changed";
        assert.equal((await env.SECURITY.cloudPasskeySession(rpcInput)).valid,false,revoke);
      } else assert.equal((await env.SECURITY.cloudPasskeySession(rpcInput)).valid,true);
    } finally {ledger.close();env.SESSION_VERSION="5";Object.assign(env.SECURITY,originalSecurity)}
  }
  console.log("PASS actual Cloud/Security multi-folder: 26-hour rolling, scheduled handoff cleanup, fixed ID/start/snapshot, new-link exclusion, non-anchor revoke, envelope/vault/credential/Identity/epoch/version/logout rejection");
} finally {globalThis.Date=OriginalDate;context.Date=OriginalDate;Object.assign(env.SECURITY,originalSecurity)}

// Exercise the real browser guard's bounded activity window and same-session
// expiry propagation without any server polling or user credential ceremony.
let clock=100000;
const shared=new Map();
function guard() {
  const local=new Map(),events=new Map();
  const storage=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)});
  const scope={fetch:async()=>new Response('{}'),Headers,URL,AbortController,ReadableStream,Response,Event,CustomEvent,crypto,
    Date:{now:()=>clock},setTimeout(){return 1},clearTimeout(){},localStorage:storage(shared),sessionStorage:storage(local),
    document:{visibilityState:'visible'},location:{origin:'https://example.test',href:'https://example.test/cloud/',replace(){}},
    addEventListener(name,callback){events.set(name,callback)},dispatchEvent(){},BroadcastChannel:class{postMessage(){}}};
  scope.globalThis=scope;
  vm.runInNewContext(readFileSync(new URL('../public/session-guard.js',import.meta.url),'utf8'),scope);
  scope.TCloudSession.bind({sessionCacheId:'same',authMethod:'passkey',role:'admin',expiresAt:200});
  return {scope,events};
}
const first=guard(),second=guard();
assert.equal(first.scope.TCloudSession.headers().get('X-TCloud-Activity'),'foreground');
clock+=60001;
assert.equal(first.scope.TCloudSession.headers().get('X-TCloud-Activity'),null,'unattended polling stops extending the session');
first.events.get('pointerdown')({isTrusted:true});
assert.equal(first.scope.TCloudSession.headers().get('X-TCloud-Activity'),'foreground');
first.scope.document.visibilityState='hidden';
assert.equal(first.scope.TCloudSession.headers({'X-TCloud-Activity':'foreground'}).get('X-TCloud-Activity'),null);
first.scope.TCloudSession.renew('different',400);
assert.equal(first.scope.TCloudSession.context().expiresAt,200);
first.scope.TCloudSession.renew('same',400);
clock=210000;
assert.equal(second.scope.TCloudSession.check().expiresAt,400,'another tab sees the renewed expiry before its old local timeout');
assert.equal(second.scope.TCloudSession.isBlocked(),false);
console.log('PASS activity guard: foreground/trusted interaction window, hidden/idle exclusion, fixed binding and cross-tab expiry');
