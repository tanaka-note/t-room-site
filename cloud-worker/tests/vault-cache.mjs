import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(client, /const VAULT_CACHE_DB = "tcloud-device-vault"/);
assert.match(client, /async function loadCachedAdminKey/);
assert.match(client, /key instanceof CryptoKey && key\.type === "private" && key\.extractable === false/);
assert.match(client, /await saveCachedAdminKey\(config, privateKey\)/);
assert.match(client, /await saveCachedAdminKey\(state\.crypto\.config, privateKey\)/);
assert.match(client, /async function clearCachedAdminKeys/);
assert.match(client, /async function logout\(\)[\s\S]*?await clearCachedAdminKeys\(\)/);
assert.match(client, /session\.authenticated[\s\S]*?rememberedPassword[\s\S]*?enterApp\(session, rememberedPassword, accountKey\)/);

console.log("admin device vault reuse and logout cleanup: ok");

const pair = await crypto.subtle.generateKey({name:"RSA-OAEP", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256"}, true, ["encrypt","decrypt"]);
const privateKey = await crypto.subtle.importKey("pkcs8", await crypto.subtle.exportKey("pkcs8",pair.privateKey), {name:"RSA-OAEP",hash:"SHA-256"},false,["decrypt"]);
const wrongPair = await crypto.subtle.generateKey({name:"RSA-OAEP", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256"}, false, ["encrypt","decrypt"]);
const config = {initialized:true,cryptoVersion:1,createdAt:"fixture",publicKeyJwk:await crypto.subtle.exportKey("jwk",pair.publicKey)};
const records = new Map();
const cryptoSource = await readFile(new URL("../public/crypto-vault.js",import.meta.url),"utf8");
function device() {
  const context={crypto, CryptoKey:globalThis.CryptoKey, TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,Map,Set,URL,URLSearchParams,AbortController,Blob,atob,btoa,
    document:{addEventListener(){}},navigator:{},location:{href:"https://example.test/cloud/"},history:{},window:{},setTimeout,clearTimeout};
  context.globalThis=context;context.window=context;
  vm.runInNewContext(cryptoSource,context);
  vm.runInNewContext(client+`\n
    passkeyCacheOperation=async(_mode,operation)=>operation({get:key=>records.get(key),put:(record,key)=>{records.set(key,structuredClone(record));return true},delete:key=>records.delete(key)});
    globalThis.cache={save:saveCachedPasskeyKeys,load:loadCachedPasskeyKeys,clear:clearCachedPasskeyKeys};`,Object.assign(context,{records,structuredClone}));
  return context;
}
const base={authMethod:"passkey",role:"admin",sessionCacheId:"session",identityId:"user",credentialId:"credential",serviceLinkId:"link",serviceAccountId:"admin",
  sessionVersion:"5",passkeySessionEpoch:1,cloudScopeId:"admin",folderScopes:[],rootFolderId:null,expiresAt:Math.floor(Date.now()/1000)+43200};
for(const role of ["admin","member"]) {
  const session={...base,role,...(role==="member"?{serviceAccountId:"folder-member",rootFolderId:7,folderScopes:[7],cloudScopeId:"folder:7"}:{})};
  const raw=crypto.getRandomValues(new Uint8Array(32));
  const wrapped=Buffer.from(await crypto.subtle.encrypt({name:"RSA-OAEP"},pair.publicKey,raw)).toString("base64url");
  let context=device();await context.cache.save(session,config,privateKey,wrapped);
  const record=records.get("passkey-session:session");
  assert.equal(record.privateKey.extractable,false);assert.equal(record.privateKey.type,"private");
  assert.deepEqual(Object.keys(record).sort(),["binding","cacheType","privateKey","sessionCacheId","wrappedFolderKey"]);
  await assert.rejects(()=>crypto.subtle.exportKey("pkcs8",record.privateKey));
  context=device(); // All app memory disappears; structured-cloned keys remain.
  assert.ok(await context.cache.load(session,config));
  for(const extra of [{sessionCacheId:"other"},{credentialId:"other"},{identityId:"other"},{role:role==="admin"?"member":"admin"},
    {cloudScopeId:"other"},{folderScopes:[99]},{rootFolderId:99},{serviceAccountId:"other"},{serviceLinkId:"other"},
    {sessionVersion:"6"},{passkeySessionEpoch:2},{authMethod:"password"},{expiresAt:1}]) {
    await context.cache.save(session,config,privateKey,wrapped);
    assert.equal(await context.cache.load({...session,...extra},config),null,JSON.stringify(extra));
  }
  await context.cache.save(session,config,privateKey,wrapped);
  assert.equal(await context.cache.load(session,{...config,cryptoVersion:2}),null);
  await context.cache.save(session,config,privateKey,wrapped);
  records.get("passkey-session:session").privateKey=pair.privateKey; // extractable record fails closed
  assert.equal(await context.cache.load(session,config),null);
  await context.cache.save(session,config,privateKey,wrapped);
  records.get("passkey-session:session").privateKey={type:"private",extractable:false};
  assert.equal(await context.cache.load(session,config),null);
  await context.cache.save(session,config,privateKey,wrapped);
  records.get("passkey-session:session").privateKey=wrongPair.privateKey;
  assert.equal(await context.cache.load(session,config),null,"a structurally valid wrong RSA key cannot restore the vault");
  await context.cache.save({...session,sessionCacheId:"other"},config,privateKey,wrapped);
  await context.cache.save(session,config,privateKey,wrapped);
  await context.cache.clear("session");
  assert.equal(await context.cache.load(session,config),null);
  assert.ok(records.has("passkey-session:other"),"logout only deletes its own session");
  records.clear();
}
console.log("PASS passkey vault: non-extractable real CryptoKeys, restart clone, all session/credential/role/scope/version bindings, corruption, timeout, selective logout");
