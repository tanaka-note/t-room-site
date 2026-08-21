import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_identity_passkeys.sql", import.meta.url), "utf8");
const client = await readFile(new URL("../public/passkey-client.js", import.meta.url), "utf8");
const cloud = await readFile(new URL("../../cloud-worker/src/index.js", import.meta.url), "utf8");
const cloudClient = await readFile(new URL("../../cloud-worker/public/cloud.js", import.meta.url), "utf8");
const cloudCrypto = await readFile(new URL("../../cloud-worker/public/crypto-vault.js", import.meta.url), "utf8");
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
  assert.match(worker, /ON CONFLICT\(credential_id, service_link_id, envelope_type\) DO UPDATE/);
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
