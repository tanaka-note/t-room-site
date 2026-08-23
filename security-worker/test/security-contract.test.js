import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { secure, SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const migration = await readFile(new URL("../migrations/0001_identity_passkeys.sql", import.meta.url), "utf8");
const lifecycleMigration = await readFile(new URL("../migrations/0002_passkey_lifecycle_integrity.sql", import.meta.url), "utf8");
const foreignKeyMigration = await readFile(new URL("../migrations/0003_repair_service_link_foreign_keys.sql", import.meta.url), "utf8");
const handoffEpochMigration = await readFile(new URL("../migrations/0004_handoff_session_epoch.sql", import.meta.url), "utf8");
const serviceAuditMigration = await readFile(new URL("../migrations/0005_service_links_and_session_audit.sql", import.meta.url), "utf8");
const client = await readFile(new URL("../public/passkey-client.js", import.meta.url), "utf8");
const securityUi = await readFile(new URL("../public/security.js", import.meta.url), "utf8");
const securityDisplay = await readFile(new URL("../public/security-display.js", import.meta.url), "utf8");
const securityHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const cloud = await readFile(new URL("../../cloud-worker/src/index.js", import.meta.url), "utf8");
const cloudClient = await readFile(new URL("../../cloud-worker/public/cloud.js", import.meta.url), "utf8");
const cloudCrypto = await readFile(new URL("../../cloud-worker/public/crypto-vault.js", import.meta.url), "utf8");
const argon2 = await readFile(new URL("../../cloud-worker/public/vendor/argon2.umd.min.js", import.meta.url), "utf8");
const diary = await readFile(new URL("../../diary-worker/src/index.js", import.meta.url), "utf8");
const billing = await readFile(new URL("../../billing-worker/src/index.js", import.meta.url), "utf8");
const sessionValidator = await readFile(new URL("../../assets/passkey-session-validation.mjs", import.meta.url), "utf8");
const globalSwitchTool = await readFile(new URL("../tools/global-passkey-switch.mjs", import.meta.url), "utf8");
const securityConfig = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

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

test("PRF request options use the WebAuthn JSON Base64URL representation", () => {
  assert.match(worker, /prfAuthenticationExtensions\(rows\.results\)/);
  assert.match(worker, /extensions: prfAuthenticationExtensions\(\[credential\]\)/);
  assert.match(worker, /\{ first: canonicalBase64Url\(credential\.prf_salt\) \}/);
  assert.doesNotMatch(worker, /first: base64UrlToBytes\(credential\.prf_salt\)/);
  assert.match(worker, /\["security", "cloud"\]\.includes\(service\)/,
    "Diary and Billing authentication do not request the T-Cloud-only PRF extension");
  assert.match(client, /class PasskeyOptionsError extends Error/);
  assert.match(client, /typeof value !== "string"/);
  assert.match(client, /toBase64Url\(bytes\) !== value/);
});

test("WebAuthn and API errors have a Japanese-only user boundary", () => {
  for (const name of ["InvalidStateError", "NotAllowedError", "AbortError", "NotSupportedError", "SecurityError", "ConstraintError", "UnknownError", "OperationError", "DataError", "TypeError"]) {
    assert.match(client, new RegExp(`(?:=== \\"${name}\\"|\\[.*\\"${name}\\")`), `${name} is handled explicitly`);
  }
  assert.match(client, /registration === "primary-admin"/);
  assert.match(client, /第一管理者のパスキーが既に登録されています/);
  assert.match(client, /このユーザーのパスキーが既に登録されています/);
  assert.match(client, /safeJapaneseMessage/);
  assert.doesNotMatch(securityUi, /preparationError\.message|再試行してください。\$\{error\.message/,
    "PRF and crypto errors are not concatenated into user-visible text");
  assert.doesNotMatch(worker, /new Response\("Not found"/);
  assert.doesNotMatch(worker, /new HttpError\(404, "Not found"\)/);
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
  assert.match(worker, /passkey_authentication_success/);
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
  assert.match(worker, /T-Cloud管理者・副管理者は通常のサービス連携から付与できません/);
  assert.doesNotMatch(worker, /mergedRole|combinedPermissions|unionPermissions/);
});

test("service links come from an explicit provider registry and never from free-form UI", () => {
  assert.match(worker, /const SERVICE_REGISTRY = Object\.freeze/);
  assert.match(worker, /CLOUD_AUTH/);
  assert.match(worker, /DIARY_AUTH/);
  assert.match(worker, /BILLING_AUTH/);
  for (const source of [cloud, diary, billing]) {
    assert.match(source, /async listLinkTargets\(\)/);
    assert.match(source, /async describeAccount\(input\)/);
  }
  assert.match(cloud, /targets: await listSecurityFolderTargets/);
  assert.match(cloud, /listSecurityFolderTargets\(this\.env, \{ topLevelOnly: true \}\)/,
    "T-Cloud selection candidates are limited to top-level folders");
  assert.match(cloud, /!topLevelOnly \|\| folder\.parentId == null/,
    "the provider filters candidates using the existing parent relationship");
  assert.match(worker, /describeAccount\(\{ accountId, rootFolderId, selectableOnly: true \}\)/,
    "new service links are revalidated against selectable top-level targets on the server");
  const cloudTargetsMethod = cloud.match(/async listLinkTargets\(\) \{([\s\S]*?)\n  \}\n\n  async getFolderCryptoRecord/)?.[1] || "";
  assert.ok(cloudTargetsMethod, "T-Cloudの候補取得メソッドを検出できます");
  assert.doesNotMatch(cloudTargetsMethod, /adminWrappedKey|folder_key|file_key|password_hash/);
  assert.doesNotMatch(securityHtml, /invite-identity-id|サービス内アカウントID|T-CloudフォルダID/);
  assert.doesNotMatch(securityUi, /window\.prompt/);
  assert.match(securityUi, /data-link-target/);
  assert.match(securityUi, /トップフォルダを選択してください。このフォルダを本人のパスキーで利用できるようにし、配下をすべて連携対象とします。他のT-Cloudフォルダは表示されません。/);
  assert.match(client, /verified\.links\.length === 1 \? verified\.links\[0\]/,
    "a single T-Cloud link is selected automatically without combining scopes");
  assert.match(client, /chooseLinkDialog/);
  assert.match(client, /利用するT-Cloudの範囲を選択/);
});

test("privileged, exclusive, Cloud-admin and root-folder policies are server enforced", () => {
  assert.match(worker, /requireFreshSecurityAdmin/);
  assert.match(worker, /PRIVILEGED_LINK_REAUTH_SECONDS = 5 \* 60/);
  assert.match(worker, /service !== "cloud" && rootFolderId !== null/);
  assert.match(worker, /accountId !== "folder-member"/);
  assert.match(worker, /assertExclusiveServiceLinksAvailable/);
  assert.match(serviceAuditMigration, /uq_security_service_links_exclusive_current/);
  assert.match(serviceAuditMigration, /service IN \('diary', 'billing'\)/);
  assert.match(worker, /PRIMARY_ADMIN_CORE_LINKS/);
  assert.match(worker, /identity\.status === "active" && link\.service !== "cloud" \? "active" : "pending"/);
});

test("session resume audit is distinct, deduplicated, human-labelled, and tracks last access", () => {
  for (const source of [cloud, diary, billing]) {
    assert.match(source, /eventType: "session_resume"/);
    assert.match(source, /serviceLinkId: session\.serviceLinkId/);
    assert.match(source, /sessionId: session\.sessionId/);
  }
  assert.match(worker, /recordSecuritySessionResume/);
  assert.match(worker, /event_type = 'session_resume'/);
  assert.match(worker, /service_account_label/);
  assert.match(worker, /last_seen_at/);
  assert.match(serviceAuditMigration, /uq_security_audit_session_resume_minute/);
  assert.match(securityDisplay, /session_resume/);
  assert.match(securityUi, /sessionResume/);
  assert.match(securityHtml, /audit-refresh/);
  assert.doesNotMatch(worker, /LOGIN_SUCCESS_EVENTS[^\n]*session_resume/);
  assert.match(worker, /last_login_at = CASE WHEN last_login_at IS NULL OR last_login_at < \?/);
  assert.match(worker, /last_seen_at = CASE WHEN last_seen_at IS NULL OR last_seen_at < \?/);
  assert.match(worker, /WHERE id = \? AND \(last_seen_at IS NULL OR last_seen_at < \?\)/);
  assert.match(cloud, /sessionId: session\.sessionId \|\| crypto\.randomUUID\(\)/,
    "legacy Cloud sessions gain one stable random session ID on rolling refresh");
});

test("async service-link labels are resolved before every JSON response", () => {
  assert.match(worker, /links: await Promise\.all\(links\.map\(\(link\) => publicLink\(env, link\)\)\)/);
  assert.match(worker, /link: await publicLink\(env, selected\)/);
  assert.doesNotMatch(worker, /link:\s*publicLink\(/);
});

test("service WebAuthn verification and completed service login use distinct audit events", () => {
  assert.match(worker, /service === "security" \? "passkey_login_success" : "passkey_authentication_success"/);
  assert.doesNotMatch(worker, /LOGIN_SUCCESS_EVENTS[^\n]*passkey_authentication_success/);
  assert.match(securityDisplay, /passkey_authentication_success/);
  for (const source of [cloud, diary, billing]) assert.match(source, /eventType: "passkey_login_success"/);
});

test("Security status validates the live administrator identity and credential before session resume", () => {
  assert.match(worker, /const admin = await activeSecurityAdminSession\(request, env\)/);
  assert.match(worker, /activeSecurityAdminSession[\s\S]*i\.is_security_admin = 1[\s\S]*i\.status = 'active'[\s\S]*c\.status = 'active'/);
  assert.doesNotMatch(worker, /\/api\/status[\s\S]{0,400}readSecuritySession\(request, env, ADMIN_COOKIE/);
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
  assert.match(securityHtml, /\/security\/security-display\.js/);
  assert.match(cloudCrypto, /deriveAccountCredentials[\s\S]*hashwasm\.argon2id/);
  assert.match(argon2, /WebAssembly\.compile/);
  assert.match(argon2, /WebAssembly\.instantiate/);
  assert.match(SECURITY_CONTENT_SECURITY_POLICY, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(cloud, /script-src 'self' 'wasm-unsafe-eval'/, "T-Cloudの既存WASM CSPも維持します");
  assert.doesNotMatch(cloud, /script-src[^;]*'unsafe-eval'/);
});

test("Security Center keeps audit localization in a reusable escaped display layer", () => {
  assert.match(securityDisplay, /bootstrap_auth_success/);
  assert.match(securityDisplay, /第一管理者の本人確認に成功/);
  assert.match(securityDisplay, /未定義の操作/);
  assert.match(securityDisplay, /formatUserAgent/);
  assert.match(securityUi, /data\.events\.map\(renderAuditEvent\)/);
  assert.match(securityUi, /escapeHtml\(display\.eventLabel\(event\.event_type\)\)/);
  assert.match(securityUi, /escapeHtml\(userAgent\)/);
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
  assert.match(securityUi, /resumePrimaryAdminSetup/);
  assert.match(securityUi, /TRoomPasskeys\.obtainPrf\(setup\.credentialId\)/, "第一管理者の再開は既存credentialをWebAuthn getで再認証します");
  assert.match(securityUi, /await showAdmin\(setup\)/, "第一管理者のT-Cloud未準備は管理画面をブロックしません");
  assert.match(securityUi, /この端末ではT-Cloudのパスキー利用に対応していません/);
  assert.match(securityHtml, /id="tcloud-setup-notice"/);
  assert.match(securityHtml, /セキュリティセンターを利用する/);
  assert.match(securityUi, /setup\/primary-admin\/verify-password/);
  assert.match(securityUi, /inviteExpiryPayload\(\)/);
  assert.match(securityUi, /日時指定の有効期限を入力してください/);
  assert.match(securityHtml, /端末のロック解除を登録/);
});

test("kill-switch epochs, atomic local audits, and malformed cookies fail closed", () => {
  assert.match(lifecycleMigration, /passkey_session_epoch INTEGER NOT NULL/);
  assert.match(handoffEpochMigration, /ADD COLUMN session_epoch INTEGER/);
  assert.match(worker, /observePasskeyRuntime/);
  assert.match(worker, /sessionEpoch: runtime\.epoch/);
  assert.match(worker, /passkeySessionEpoch: runtime\.epoch/);
  assert.match(worker, /Number\(value\.passkeySessionEpoch\) === runtime\.epoch/);
  assert.match(globalSwitchTool, /passkey_session_epoch = passkey_session_epoch \+ 1/);
  assert.match(globalSwitchTool, /d1Step\("disable-runtime"[\s\S]*switchStep\("false"\)/);
  assert.match(globalSwitchTool, /switchStep\("false"\)[\s\S]*switchStep\("true"\)[\s\S]*d1Step\("enable-runtime"/);
  assert.match(worker, /Boolean\(requestedEnabled\) && Number\(state\?\.switch_observed_enabled\) === 1/,
    "the persistent runtime gate blocks issuance while the Secret deployment is in flight");
  assert.doesNotMatch(worker, /observePasskeyRuntime[\s\S]{0,1000}SET switch_observed_enabled = 1/,
    "a request cannot implicitly reopen a globally disabled runtime gate");
  assert.match(globalSwitchTool, /secret", "bulk/);
  assert.doesNotMatch(securityConfig, /"PASSKEY_ENABLED"\s*:/, "global switch state is preserved as a Secret binding across normal deploys");
  assert.match(worker, /PASSKEY_ENABLED \|\| "false"/, "a missing global switch binding fails closed");
  assert.doesNotMatch(sessionValidator, /servicePasskeyEnabled/);
  assert.match(sessionValidator, /PASSKEY_ENABLED[\s\S]*return false/);
  assert.match(worker, /localAuditStatement/);
  assert.match(worker, /const parts = token\.split\("\."\)/);
  assert.match(worker, /if \(parts\.length !== 2\) return null/);
  for (const source of [cloud, diary, billing]) {
    assert.match(source, /passkeySessionEpoch/);
  }
  assert.match(diary, /passkeySessionEpoch: session\.passkeySessionEpoch/);
  assert.match(diary, /path === "\/api\/households\/select"[\s\S]*passkeySessionEpoch: session\.passkeySessionEpoch/,
    "Diary household switching preserves the Security epoch when reissuing a passkey cookie");
  assert.match(billing, /passkeySessionEpoch: session\.passkeySessionEpoch/);
});

test("multiple Cloud links share one credential vault and keep per-link folder envelopes", () => {
  assert.match(lifecycleMigration, /CREATE TABLE security_tcloud_client_vaults/);
  assert.match(lifecycleMigration, /credential_id TEXT PRIMARY KEY/);
  assert.match(migration, /UNIQUE \(credential_id, service_link_id, envelope_type\)/);
  assert.match(worker, /cloudLinks: \(cloudLinks\.results \|\| \[\]\)\.map/);
  assert.doesNotMatch(worker, /cloud_root_folder_id FROM security_service_links WHERE identity_id = \? AND service = 'cloud' AND status IN \('pending', 'active'\) LIMIT 1/);
});

test("Cloud authentication candidates are credential-ready, while completed setup sessions are read-only", () => {
  assert.match(worker, /security_tcloud_client_vaults v[\s\S]*folder_key_rsa/);
  assert.match(worker, /activeLinks\(env, credential\.identity_id, service, credentialId\)/);
  assert.match(worker, /missingCloudLinks/);
  assert.match(worker, /cloudPendingCount/);
  assert.match(worker, /readSetupSession\(request, env, \["active", "completed"\]\)/);
  assert.match(worker, /async function readSetupSession\(request, env, allowedStatuses = \["active"\]\)/);
  assert.match(worker, /completed: setup\.status === "completed"/);
});

test("lost setup cookies can only be resumed from the current signed passkey session", () => {
  assert.match(worker, /path === "\/api\/setup\/resume"/);
  assert.match(worker, /currentSetupActor\(request, env\)/);
  assert.match(worker, /adminSession\.credentialId !== session\.credentialId/);
  assert.match(worker, /SET status = 'expired'[\s\S]*status = 'active'/);
  assert.match(worker, /WHERE identity_id = \? AND credential_id = \? AND status = 'completed'/);
  assert.match(client, /resumeSetup/);
  assert.doesNotMatch(securityUi, /navigator\.credentials\.create/,
    "setup resume delegates to obtainPrf(), which uses the existing credential with get()");
});

test("authentication-time PRF absence never downgrades registration-time capability", () => {
  assert.match(worker, /UPDATE security_credentials SET counter = \?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = \?/);
  assert.doesNotMatch(worker, /last_used_at = CURRENT_TIMESTAMP, prf_enabled = \?/);
  assert.match(worker, /prfAvailable: Boolean\(body\.prfAvailable\)/);
});

test("audit history uses stable composite cursor pagination", () => {
  assert.match(worker, /ORDER BY occurred_at DESC, event_id ASC LIMIT \?/);
  assert.match(worker, /occurred_at < \? OR \(occurred_at = \? AND event_id > \?\)/);
  assert.match(worker, /nextCursor/);
  assert.match(securityHtml, /id="audit-load-more"[\s\S]*もっと見る/);
  assert.match(securityUi, /params\.set\("cursor", state\.auditCursor\)/);
  assert.match(securityUi, /insertAdjacentHTML\("beforeend"/);
});

test("WebAuthn credential IDs and audit retention use standards-aligned boundaries", () => {
  assert.match(worker, /DELETE FROM security_audit_events WHERE occurred_at < \?/);
  assert.doesNotMatch(worker, /security_audit_events WHERE occurred_at < datetime/);
  assert.match(worker, /auditRetentionCutoff/);
});

test("bootstrap obtains encrypted Cloud config through a private binding without creating a Cloud PW cookie", () => {
  assert.match(cloud, /getPrimaryAdminCryptoConfig/);
  assert.match(worker, /CLOUD_AUTH\.getPrimaryAdminCryptoConfig/);
  assert.doesNotMatch(securityUi, /cloudApi\("\/login"/);
});
