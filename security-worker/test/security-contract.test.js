import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { secure, SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_identity_passkeys.sql", import.meta.url), "utf8");
const lifecycleMigration = await readFile(new URL("../migrations/0002_passkey_lifecycle_integrity.sql", import.meta.url), "utf8");
const foreignKeyMigration = await readFile(new URL("../migrations/0003_repair_service_link_foreign_keys.sql", import.meta.url), "utf8");
const handoffEpochMigration = await readFile(new URL("../migrations/0004_handoff_session_epoch.sql", import.meta.url), "utf8");
const client = await readFile(new URL("../public/passkey-client.js", import.meta.url), "utf8");
const securityUi = await readFile(new URL("../public/security.js", import.meta.url), "utf8");
const securityHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const cloud = await readFile(new URL("../../cloud-worker/src/index.js", import.meta.url), "utf8");
const cloudClient = await readFile(new URL("../../cloud-worker/public/cloud.js", import.meta.url), "utf8");
const cloudCrypto = await readFile(new URL("../../cloud-worker/public/crypto-vault.js", import.meta.url), "utf8");
const argon2 = await readFile(new URL("../../cloud-worker/public/vendor/argon2.umd.min.js", import.meta.url), "utf8");
const diary = await readFile(new URL("../../diary-worker/src/index.js", import.meta.url), "utf8");
const billing = await readFile(new URL("../../billing-worker/src/index.js", import.meta.url), "utf8");

test("WebAuthn requires a platform discoverable credential and user verification", () => {
  assert.match(worker, /authenticatorAttachment: "platform"/);
  assert.match(worker, /residentKey: "required"/);
  assert.match(worker, /requireResidentKey: true/);
  assert.match(worker, /userVerification: "required"/);
  assert.match(worker, /expectedOrigin: expectedOrigins\(env\)/);
  assert.match(worker, /expectedRPID: rpId\(env\)/);
  assert.match(worker, /requireUserVerification: true/);
});

test("invite, challenge, and handoff values are hashed, expiring, and one-use", () => {
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /challenge_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /consumed_at INTEGER/);
  assert.match(worker, /expires_at > \?/);
  assert.match(worker, /SET consumed_at = \? WHERE id = \? AND consumed_at IS NULL/);
  assert.match(worker, /MAX_INVITE_DAYS/);
  assert.match(worker, /\/security\/#invite=/, "招待tokenはHTTPリクエストやReferrerへ出ないfragmentに置きます");
  assert.doesNotMatch(worker, /\/security\/\?invite=/);
  assert.doesNotMatch(migration, /(?:^|\s)(?:password|password_hash|auth_proof|session_cookie|private_key_pem|private_key_jwk)\s+(?:TEXT|BLOB)/im);
  assert.match(lifecycleMigration, /registered_via_invitation_id TEXT/);
  assert.match(lifecycleMigration, /UNIQUE INDEX uq_security_credentials_invitation/);
});

test("PRF output remains client-side and T-Cloud stores only encrypted envelopes", () => {
  assert.match(client, /PRF result is intentionally omitted/);
  assert.match(client, /results: undefined/);
  assert.doesNotMatch(worker, /prfOutput|prf_output/);
  assert.match(migration, /encrypted_payload TEXT/);
  assert.match(migration, /wrapped_key TEXT/);
  assert.doesNotMatch(migration, /plaintext|folder_key TEXT|file_key TEXT/);
});

test("all three services keep password login and add one-time handoff", () => {
  for (const source of [cloud, diary, billing]) {
    assert.match(source, /\/api\/login/);
    assert.match(source, /\/api\/passkey\/handoff/);
    assert.match(source, /redeemHandoff/);
  }
});

test("a T-Cloud member is constrained to the linked root on direct ID access", () => {
  assert.match(cloud, /session\.role === "member"/);
  assert.match(cloud, /folderWithinShare\(env, folderId, session\.rootFolderId\)/);
  assert.match(cloud, /このフォルダへアクセスする権限がありません/);
  assert.match(cloud, /effectiveRootId = folderId \|\| \(session\.role === "member" \? session\.rootFolderId : null\)/);
  assert.match(cloud, /requireMemberFolderScope/);
  assert.match(cloud, /cloud_folder_unlocks WHERE session_id = \? AND folder_id = \? AND expires_at > \?/);
  assert.match(cloud, /adminWrappedKey: folder\.admin_wrapped_key/, "管理者端末でのみフォルダ鍵を委譲できる暗号化済みkeyを内部bindingへ返します");
});

test("Security Center is first-admin-only and audits success and failure", () => {
  assert.match(worker, /is_security_admin = 1/);
  assert.match(worker, /passkey_login_success/);
  assert.match(worker, /passkey_authentication_failure/);
  assert.match(cloud, /password_login_success/);
  assert.match(diary, /password_login_success/);
  assert.match(billing, /password_login_success/);
});

test("first administrator password recovery remains available after initialization", () => {
  assert.match(worker, /verifyPrimaryAdmin/);
  assert.match(worker, /enforceBootstrapAttemptLimit/);
  assert.doesNotMatch(worker, /if \(await hasSecurityAdmin\(env\)\) throw new HttpError\(409/);
  assert.match(client, /bootstrap/);
});

test("reinvite creates a credential-specific T-Cloud envelope without replacing password wraps", () => {
  assert.match(worker, /status IN \('pending', 'active'\)/);
  assert.match(worker, /security_tcloud_client_vaults/);
  assert.match(worker, /public_key_fingerprint/);
  assert.match(cloudClient, /unlockPasskeyClientPrivateKey/);
  assert.match(cloudClient, /unlockDelegatedFolderKey/);
  assert.match(cloudCrypto, /RSA-OAEP/);
  assert.doesNotMatch(worker, /password_wrapped_key\s*=|admin_wrapped_key\s*=/);
  assert.match(worker, /CASE WHEN status = 'active' THEN 'active' ELSE 'pending_approval' END/, "再招待中も既存credentialを利用不能にしません");
  assert.match(worker, /credential_id = \? AND status = 'pending'/, "承認対象credentialだけを有効化します");
  assert.match(worker, /c\.credential_id = \? AND c\.status = 'active'/, "無効化済みcredentialの管理sessionを拒否します");
  assert.match(worker, /createHandoff[\s\S]*requireActiveIdentitySession/, "承認待ちの再招待credentialはhandoffを発行できません");
  assert.match(worker, /UPDATE security_service_links SET status = 'disabled'/, "連携解除は監査参照を壊さない無効化として保持します");
  assert.match(worker, /cloud_root_folder_id, status FROM security_service_links/, "招待後の連携状態変更も招待hashで検出します");
});

test("service-account roles stay authoritative and are not combined in Security Center", () => {
  assert.match(worker, /redeemHandoff/);
  assert.match(worker, /service_account_id AS serviceAccountId/);
  assert.match(worker, /T-Cloudの管理者・副管理者パスキーは第一管理者の復旧登録とは分離/);
  assert.doesNotMatch(worker, /mergedRole|combinedPermissions|unionPermissions/);
});

test("Security Center response permits WebAssembly without allowing JavaScript eval", async () => {
  const response = secure(new Response("ok"));
  const csp = response.headers.get("Content-Security-Policy");
  assert.equal(csp, SECURITY_CONTENT_SECURITY_POLICY);

  const directives = new Map(csp.split(";").map((value) => value.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
  const scriptSources = directives.get("script-src") || [];
  assert.deepEqual(scriptSources, ["'self'", "'wasm-unsafe-eval'"]);
  assert.ok(!scriptSources.includes("'unsafe-eval'"));
  assert.ok(!scriptSources.includes("'unsafe-inline'"));
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.deepEqual(directives.get("base-uri"), ["'none'"]);
  assert.deepEqual(directives.get("form-action"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
});

test("Security Center Argon2/WebAssembly assets and CSP remain consistent", () => {
  assert.match(securityHtml, /\/cloud\/vendor\/argon2\.umd\.min\.js/);
  assert.match(securityHtml, /\/cloud\/crypto-vault\.js/);
  assert.match(cloudCrypto, /deriveAccountCredentials[\s\S]*hashwasm\.argon2id/);
  assert.match(argon2, /WebAssembly\.compile/);
  assert.match(argon2, /WebAssembly\.instantiate/);
  assert.match(SECURITY_CONTENT_SECURITY_POLICY, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(cloud, /script-src 'self' 'wasm-unsafe-eval'/, "T-Cloudの既存WASM CSPも維持します");
  assert.doesNotMatch(cloud, /script-src[^;]*'unsafe-eval'/);
});

test("Identity routes, audit service and invitation lifecycle share the hardened contracts", () => {
  assert.ok(worker.includes("/^\\/api\\/identities\\/([A-Za-z0-9_-]{1,64})$/"));
  assert.match(worker, /normalizeIdentityId\(body\.identityId\)/);
  assert.match(worker, /normalizeAuditService/);
  assert.match(worker, /currentJstDayBounds/);
  assert.match(worker, /LOGIN_FAILURE_EVENTS/);
  assert.match(worker, /resolveInviteExpiry/);
  assert.match(worker, /UPDATE security_invitations SET status = 'revoked'.*identity_id = \?.*status = 'active'/s);
  assert.match(worker, /assertUniqueServiceLinks/);
  assert.match(worker, /await env\.DB\.batch\(statements\)/);
  assert.match(worker, /enforceAuthenticationOptionsRateLimit/);
  assert.match(worker, /passkey_authentication_options/);
  assert.match(worker, /Number\(recent\?\.attempts \|\| 0\) >= 20/);
  assert.match(lifecycleMigration, /COALESCE\(cloud_root_folder_id, -1\)/);
  assert.match(lifecycleMigration, /WHERE status IN \('pending', 'active'\)/);
  assert.match(foreignKeyMigration, /REFERENCES security_service_links\(id\)/);
  assert.doesNotMatch(worker, /status = 'pending'.*WHERE id = \?/, "disabled service-link rows are never reactivated");
});

test("all service passkey sessions carry revocable Security identifiers and validate on protected access", async () => {
  for (const [name, source] of [["cloud", cloud], ["diary", diary], ["billing", billing]]) {
    assert.match(source, /credentialId: handoff\.credentialId/,
      `${name} stores the passkey credential in its local session`);
    assert.match(source, /serviceLinkId: handoff\.serviceLinkId/,
      `${name} stores the Security link in its local session`);
    assert.match(source, /validateServicePasskeySession\(payload, env, /,
      `${name} revalidates service sessions through the shared fail-closed helper`);
    assert.match(source, /passkey-session-validation\.mjs/,
      `${name} validates credential, Identity, link and kill switch through Security`);
  }
  assert.match(worker, /async validatePasskeySession\(input\)/);
  assert.match(worker, /c\.status = 'active'[\s\S]*i\.status = 'active'[\s\S]*l\.status = 'active'/);
});

test("registration partial success remains usable outside T-Cloud and T-Cloud preparation is retryable", () => {
  assert.match(client, /obtainPrfSafely/);
  assert.match(client, /prfPreparationFailed/);
  assert.match(worker, /UPDATE security_service_links SET status = 'active'.*service != 'cloud'/);
  assert.match(worker, /envelopeType === "admin_private_prf"[\s\S]*UPDATE security_service_links SET status = 'active'/);
  assert.match(worker, /security_setup_sessions/);
  assert.match(worker, /last_user_verification_at/);
  assert.match(worker, /security_tcloud_client_vaults/);
  assert.match(securityUi, /パスキー登録は完了しました。日記・請求書では承認後に利用できます/);
  assert.match(securityUi, /T-Cloudの準備を再試行/);
  assert.match(securityUi, /inviteExpiryPayload\(\)/);
  assert.match(securityUi, /日時指定の有効期限を入力してください/);
  assert.match(securityHtml, /端末のロック解除を登録/);
});

test("kill-switch epochs, atomic local audits, and malformed cookies fail closed", () => {
  assert.match(lifecycleMigration, /passkey_session_epoch INTEGER NOT NULL/);
  assert.match(handoffEpochMigration, /ADD COLUMN session_epoch INTEGER/);
  assert.match(worker, /observePasskeyRuntime/);
  assert.match(worker, /sessionEpoch: runtime\.epoch/);
  assert.match(worker, /localAuditStatement/);
  assert.match(worker, /const parts = token\.split\("\."\)/);
  assert.match(worker, /if \(parts\.length !== 2\) return null/);
  for (const source of [cloud, diary, billing]) {
    assert.match(source, /passkeySessionEpoch/);
  }
  assert.match(diary, /passkeySessionEpoch: session\.passkeySessionEpoch/);
  assert.match(billing, /passkeySessionEpoch: session\.passkeySessionEpoch/);
});

test("multiple Cloud links share one credential vault and keep per-link folder envelopes", () => {
  assert.match(lifecycleMigration, /CREATE TABLE security_tcloud_client_vaults/);
  assert.match(lifecycleMigration, /credential_id TEXT PRIMARY KEY/);
  assert.match(migration, /UNIQUE \(credential_id, service_link_id, envelope_type\)/);
  assert.match(worker, /cloudLinks: \(cloudLinks\.results \|\| \[\]\)\.map/);
  assert.doesNotMatch(worker, /cloud_root_folder_id FROM security_service_links WHERE identity_id = \? AND service = 'cloud' AND status IN \('pending', 'active'\) LIMIT 1/);
});

test("bootstrap obtains encrypted Cloud config through a private binding without creating a Cloud PW cookie", () => {
  assert.match(cloud, /getPrimaryAdminCryptoConfig/);
  assert.match(worker, /CLOUD_AUTH\.getPrimaryAdminCryptoConfig/);
  assert.doesNotMatch(securityUi, /cloudApi\("\/login"/);
});
