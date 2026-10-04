import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import * as domain from "../../security-worker/src/security-domain.js";

export function attachPasskeyLedger(env, { realValidation = false } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../../security-worker/migrations/", import.meta.url)).filter(f => f.endsWith(".sql")).sort())
    db.exec(readFileSync(new URL("../../security-worker/migrations/" + name, import.meta.url), "utf8"));
  const source = readFileSync(new URL("../../security-worker/src/index.js", import.meta.url), "utf8");
  const extract = name => {
    const start = source.search(new RegExp("^(?:async )?function " + name + "\\(", "m"));
    const end = source.slice(start + 1).search(/\n(?:async )?function /);
    return source.slice(start, end < 0 ? undefined : start + 1 + end);
  };
  const context = { ...domain, Date, Number, String, Math,
    sha256: text => createHash("sha256").update(text).digest("base64url"),
    validatePasskeySession: (_env, input) => env.SECURITY.validatePasskeySession(input),
    nowSeconds: () => Math.floor(Date.now() / 1000),
    validSessionStart: value => Number.isFinite(Date.parse(value)) ? value : null };

  const fixtureEnv = { DB: { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args) || null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; } };
  } } };
  Object.defineProperty(fixtureEnv, "PASSKEY_ENABLED", { get: () => env.PASSKEY_ENABLED });
  const helpers = ["normalizeCloudFolderScopes", "parseJson", "normalizeId", "normalizeText"];
  if (realValidation) helpers.push("validatePasskeySession", "validCloudFolderScopes", "activeLinks", "observePasskeyRuntime", "passkeysEnabled", "redeemHandoff", "normalizeService", "normalizeSecretText");
  vm.runInNewContext(helpers.map(extract).join("\n") + "\n" + extract("cloudPasskeySession") + ";globalThis.ledger=cloudPasskeySession", context);
  if (realValidation) {
    env.SECURITY.validatePasskeySession = input => context.validatePasskeySession(fixtureEnv, input);
    env.SECURITY.redeemHandoff = (token, service) => context.redeemHandoff(fixtureEnv, token, service);
  }
  env.SECURITY.cloudPasskeySession = input => context.ledger(fixtureEnv, input);
  return db;
}

// Public authorization metadata and encrypted fixture placeholders only.
export function seedMultiFolderHandoff(db, token = "cloud-member") {
  const folderScopes=[{serviceLinkId:"primary-admin-folder-member",rootFolderId:7},{serviceLinkId:"primary-admin-second",rootFolderId:9}];
  db.exec("INSERT INTO security_identities(id,display_name,status) VALUES('primary-admin','Fixture','active'); INSERT INTO security_credentials(credential_id,identity_id,public_key,prf_salt,status) VALUES('Y3JlZGVudGlhbA','primary-admin','AQI','AQI','active'); INSERT INTO security_tcloud_client_vaults(credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv) VALUES('Y3JlZGVudGlhbA','primary-admin','{}','fingerprint','cipher','iv')");
  for (const scope of folderScopes) {
    db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES(?,'primary-admin','cloud','folder-member',?,'Folder','active')").run(scope.serviceLinkId,scope.rootFolderId);
    db.prepare("INSERT INTO security_tcloud_key_envelopes(id,identity_id,credential_id,service_link_id,envelope_type,wrapped_key) VALUES(?,'primary-admin','Y3JlZGVudGlhbA',?,'folder_key_rsa','encrypted-fixture')").run('envelope-'+scope.rootFolderId,scope.serviceLinkId);
  }
  db.prepare("INSERT INTO security_handoffs(id,token_hash,identity_id,credential_id,service_link_id,session_epoch,expires_at,cloud_folder_scopes) VALUES('multi-snapshot',?,'primary-admin','Y3JlZGVudGlhbA',?,1,?,?)").run(createHash('sha256').update(token).digest('base64url'),folderScopes[0].serviceLinkId,Math.floor(Date.now()/1000)+60,JSON.stringify(folderScopes));
  return folderScopes;
}
