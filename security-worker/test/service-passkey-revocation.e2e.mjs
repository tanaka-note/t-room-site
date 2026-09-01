import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

globalThis.window = globalThis;
await import("../../cloud-worker/public/vendor/argon2.umd.min.js");
await import("../../cloud-worker/public/crypto-vault.js");

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sessionSecret = "passkey-session-integration-secret";
const securitySessionSecret = "security-integration-secret";
const identityId = "passkey_session_test";
const credentialId = Buffer.from("passkey-session-credential").toString("base64url");
const readinessIdentityId = "cloud_readiness_test";
const readinessCredentialA = Buffer.from("cloud-readiness-credential-a").toString("base64url");
const readinessCredentialB = Buffer.from("cloud-readiness-credential-b").toString("base64url");
const primaryCredentialId = Buffer.from("primary-admin-setup-credential").toString("base64url");
const statusAdminIdentityId = "status_admin_test";
const statusAdminCredentialId = Buffer.from("status-admin-credential").toString("base64url");
const legacyNestedIdentityId = "legacy_nested_cloud_test";
const disabledLifecycleIdentityId = "identity_disable_test";
const disabledLifecycleCredentialId = Buffer.from("identity-disable-credential").toString("base64url");
const disabledLifecycleCloudLinkId = "identity-disable-cloud-link";
const disabledLifecycleDiaryLinkId = "identity-disable-diary-link";
const cloudFixtureTag = randomUUID();
const cloudSelectedRootName = `Security連携テスト-${cloudFixtureTag}`;
const cloudChildName = `子フォルダ-${cloudFixtureTag}`;
const cloudGrandchildName = `孫フォルダ-${cloudFixtureTag}`;
const cloudProtectedChildName = `追加保護-${cloudFixtureTag}`;
const cloudProtectedGrandchildName = `追加保護配下-${cloudFixtureTag}`;
const cloudUnselectedRootName = `未選択トップ-${cloudFixtureTag}`;
const cloudRootAuthProof = `root-proof-${cloudFixtureTag}`;
const cloudProtectedPassword = `child-password-${cloudFixtureTag}`;
const cloudAdminAuthProof = `admin-proof-${cloudFixtureTag}`;
const cloudSubadminAuthProof = `subadmin-proof-${cloudFixtureTag}`;
const cloudRootFileName = `本人検索-${cloudFixtureTag}.txt`;
const cloudProtectedFileName = `保護配下-${cloudFixtureTag}.txt`;
const cloudUnselectedFileName = `他人検索-${cloudFixtureTag}.txt`;
const diaryAdminPassword = "audit-main-admin-password";
const diaryUserPassword = "audit-main-user-password";
const diaryWifePassword = "audit-wife-password";
let cloudSelectedRootId = null;
let cloudChildId = null;
let cloudGrandchildId = null;
let cloudProtectedChildId = null;
let cloudProtectedGrandchildId = null;
let cloudUnselectedRootId = null;
let cloudRootFileId = null;
let cloudProtectedFileId = null;
let cloudUnselectedFileId = null;
const diaryAdminLinkId = "passkey-session-diary-admin-link";
const services = {
  cloud: {
    directory: "cloud-worker", port: 8811, cookie: "troom_cloud_session", linkId: "passkey-session-cloud-link",
    accountId: "admin", path: "/cloud/api/items", version: "5"
  },
  diary: {
    directory: "diary-worker", port: 8812, cookie: "troom_diary_session", linkId: "passkey-session-diary-link",
    accountId: "main-user", path: "/diary/api/entries?limit=1", version: "3"
  },
  billing: {
    directory: "billing-worker", port: 8813, cookie: "troom_billing_session", linkId: "passkey-session-billing-link",
    accountId: "owner", path: "/billing/api/accounts", version: "3"
  }
};

const processes = [];

try {
  const serviceBindingAdminKeys = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"]
  );
  const serviceBindingRecipientKeys = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"]
  );
  const serviceBindingRecipientPublicJwk = await crypto.subtle.exportKey("jwk", serviceBindingRecipientKeys.publicKey);
  const serviceBindingFolderPackage = await TRoomCrypto.createFolderPackage(
    cloudSelectedRootName,
    "service-binding-folder-password",
    serviceBindingAdminKeys.publicKey
  );
  for (const directory of ["security-worker", "cloud-worker", "diary-worker", "billing-worker", "ai-worker"]) {
    runWrangler(directory, ["d1", "migrations", "apply", databaseName(directory), "--local"]);
  }
  runWrangler("diary-worker", ["d1", "execute", "diary-db", "--local", "--command", `
    UPDATE diary_accounts SET password_hash = '${sha256PasswordHash(diaryUserPassword)}', must_change_password = 0
      WHERE id = 'main-user'`]);
  runWrangler("cloud-worker", ["d1", "execute", "cloud-db", "--local", "--command", `
    INSERT INTO cloud_folders (parent_id, name, created_by) VALUES (NULL, '${cloudSelectedRootName}', 'admin');
    INSERT INTO cloud_folders (parent_id, name, created_by)
      VALUES ((SELECT id FROM cloud_folders WHERE name = '${cloudSelectedRootName}' ORDER BY id DESC LIMIT 1), '${cloudChildName}', 'admin');
    INSERT INTO cloud_folders (parent_id, name, created_by)
      VALUES ((SELECT id FROM cloud_folders WHERE name = '${cloudChildName}' ORDER BY id DESC LIMIT 1), '${cloudGrandchildName}', 'admin');
    INSERT INTO cloud_folders (parent_id, name, created_by)
      VALUES ((SELECT id FROM cloud_folders WHERE name = '${cloudSelectedRootName}' ORDER BY id DESC LIMIT 1), '${cloudProtectedChildName}', 'admin');
    INSERT INTO cloud_folders (parent_id, name, created_by)
      VALUES ((SELECT id FROM cloud_folders WHERE name = '${cloudProtectedChildName}' ORDER BY id DESC LIMIT 1), '${cloudProtectedGrandchildName}', 'admin');
    INSERT INTO cloud_folders (parent_id, name, created_by) VALUES (NULL, '${cloudUnselectedRootName}', 'admin');
    UPDATE cloud_folders SET password_hash = '${fixturePasswordHash(cloudRootAuthProof)}'
      WHERE name = '${cloudSelectedRootName}';
    UPDATE cloud_folders SET crypto_version = 1,
      encrypted_name = '${serviceBindingFolderPackage.payload.encryptedName}',
      name_iv = '${serviceBindingFolderPackage.payload.nameIv}',
      password_salt = '${serviceBindingFolderPackage.payload.passwordSalt}',
      password_wrapped_key = '${serviceBindingFolderPackage.payload.passwordWrappedKey}',
      password_wrap_iv = '${serviceBindingFolderPackage.payload.passwordWrapIv}',
      admin_wrapped_key = '${serviceBindingFolderPackage.payload.adminWrappedKey}'
      WHERE name = '${cloudSelectedRootName}';
    UPDATE cloud_folders SET password_hash = '${fixturePasswordHash(cloudProtectedPassword)}'
      WHERE name = '${cloudProtectedChildName}';
    INSERT INTO cloud_files
      (folder_id, object_key, original_name, mime_type, media_kind, size_bytes, status, created_by,
       display_metadata_version, display_name, display_mime_type, display_media_kind)
      VALUES
      ((SELECT id FROM cloud_folders WHERE name = '${cloudSelectedRootName}' ORDER BY id DESC LIMIT 1),
       'fixtures/${cloudFixtureTag}/root', '${cloudRootFileName}', 'audio/mpeg', 'audio', 10, 'ready', 'admin', 1,
       '${cloudRootFileName}', 'audio/mpeg', 'audio'),
      ((SELECT id FROM cloud_folders WHERE name = '${cloudProtectedGrandchildName}' ORDER BY id DESC LIMIT 1),
       'fixtures/${cloudFixtureTag}/protected', '${cloudProtectedFileName}', 'audio/mpeg', 'audio', 11, 'ready', 'admin', 1,
       '${cloudProtectedFileName}', 'audio/mpeg', 'audio'),
      ((SELECT id FROM cloud_folders WHERE name = '${cloudUnselectedRootName}' ORDER BY id DESC LIMIT 1),
       'fixtures/${cloudFixtureTag}/outside', '${cloudUnselectedFileName}', 'audio/mpeg', 'audio', 12, 'ready', 'admin', 1,
       '${cloudUnselectedFileName}', 'audio/mpeg', 'audio')`]);
  cloudSelectedRootId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudSelectedRootName}' ORDER BY id DESC LIMIT 1`);
  cloudChildId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudChildName}' ORDER BY id DESC LIMIT 1`);
  cloudGrandchildId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudGrandchildName}' ORDER BY id DESC LIMIT 1`);
  cloudProtectedChildId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudProtectedChildName}' ORDER BY id DESC LIMIT 1`);
  cloudProtectedGrandchildId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudProtectedGrandchildName}' ORDER BY id DESC LIMIT 1`);
  cloudUnselectedRootId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_folders WHERE name = '${cloudUnselectedRootName}' ORDER BY id DESC LIMIT 1`);
  cloudRootFileId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_files WHERE object_key = 'fixtures/${cloudFixtureTag}/root'`);
  cloudProtectedFileId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_files WHERE object_key = 'fixtures/${cloudFixtureTag}/protected'`);
  cloudUnselectedFileId = queryNumber("cloud-worker", "cloud-db", `SELECT id AS value FROM cloud_files WHERE object_key = 'fixtures/${cloudFixtureTag}/outside'`);
  cleanupSecurityFixture();
  runSecuritySql(`
    UPDATE security_runtime_state SET passkey_session_epoch = 1, switch_observed_enabled = 1 WHERE id = 1;
    INSERT INTO security_identities (id, display_name, status) VALUES ('${identityId}', 'Passkey Session Test', 'active');
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_enabled, prf_salt, status, approved_at)
      VALUES ('${credentialId}', '${identityId}', 'test-public-key', 1, 'dGVzdC1wcmYtc2FsdA', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES
      ('${services.cloud.linkId}', '${identityId}', 'cloud', '${services.cloud.accountId}', 'Cloud Test', 'active'),
      ('${services.diary.linkId}', '${identityId}', 'diary', '${services.diary.accountId}', 'Diary Test', 'active'),
      ('${services.billing.linkId}', '${identityId}', 'billing', '${services.billing.accountId}', 'Billing Test', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('${diaryAdminLinkId}', '${identityId}', 'diary', 'main-admin', 'Diary Admin Switch Test', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('setup-cloud-member', '${identityId}', 'cloud', 'folder-member', 42, 'Setup Cloud', 'pending');
    INSERT INTO security_identities (id, display_name, status, is_security_admin)
      VALUES ('audit_admin', 'Audit Failure Admin', 'active', 1);
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('audit-credential', 'audit_admin', 'test-public-key', 'dGVzdC1wcmYtc2FsdA', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_identities (id, display_name, status)
      VALUES ('${readinessIdentityId}', 'Cloud Readiness Test', 'active');
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('${readinessCredentialA}', '${readinessIdentityId}', 'public-a', 'c2FsdC1h', 'active', CURRENT_TIMESTAMP),
             ('${readinessCredentialB}', '${readinessIdentityId}', 'public-b', 'c2FsdC1i', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('readiness-cloud-link', '${readinessIdentityId}', 'cloud', 'folder-member', ${cloudSelectedRootId}, 'Cloud Readiness', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('readiness-cloud-admin-link', '${readinessIdentityId}', 'cloud', 'admin', 'T-Cloud 管理者', 'active');
    INSERT INTO security_tcloud_client_vaults
      (credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
      VALUES ('${readinessCredentialA}', '${readinessIdentityId}', '{"kty":"RSA"}', 'fingerprint-a', 'private-a', 'iv-a'),
             ('${readinessCredentialB}', '${readinessIdentityId}', '{"kty":"RSA"}', 'fingerprint-b', 'private-b', 'iv-b');
    INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
      VALUES ('readiness-envelope-a', '${readinessIdentityId}', '${readinessCredentialA}', 'readiness-cloud-link', 'folder_key_rsa', 'wrapped-a');
    INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, encrypted_payload, payload_iv)
      VALUES ('readiness-admin-envelope-a', '${readinessIdentityId}', '${readinessCredentialA}', 'readiness-cloud-admin-link', 'admin_private_prf', 'admin-private-a', 'admin-iv-a');
    INSERT INTO security_identities (id, display_name, status, is_security_admin)
      VALUES ('primary-admin', '田中宏知', 'active', 1);
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_enabled, prf_salt, status, approved_at)
      VALUES ('${primaryCredentialId}', 'primary-admin', 'primary-public-key', 1, 'cHJpbWFyeS1zYWx0', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('primary-admin-cloud-link', 'primary-admin', 'cloud', 'admin', 'T-Cloud 管理者', 'pending'),
             ('primary-admin-cloud-subadmin-link', 'primary-admin', 'cloud', 'subadmin', 'T-Cloud 副管理者', 'active');
    INSERT INTO security_identities (id, display_name, status)
      VALUES ('shared_cloud_test', 'Shared Cloud Test', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('shared-provider-cloud-link', 'shared_cloud_test', 'cloud', 'folder-member', ${cloudSelectedRootId}, 'Security連携テスト', 'active');
    INSERT INTO security_identities (id, display_name, status)
      VALUES ('${legacyNestedIdentityId}', 'Legacy Nested Cloud Test', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('legacy-nested-cloud-link', '${legacyNestedIdentityId}', 'cloud', 'folder-member', ${cloudChildId}, 'Legacy Child Snapshot', 'active');
    INSERT INTO security_identities (id, display_name, status, is_security_admin)
      VALUES ('${statusAdminIdentityId}', 'Status Admin Test', 'active', 1);
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('${statusAdminCredentialId}', '${statusAdminIdentityId}', 'status-public-key', 'c3RhdHVzLXNhbHQ', 'active', CURRENT_TIMESTAMP);
  `);

  const diaryVersion = queryNumber("diary-worker", "diary-db", "SELECT session_version AS value FROM diary_accounts WHERE id = 'main-user'");
  const billingVersion = queryNumber("billing-worker", "billing-db", "SELECT session_version AS value FROM billing_accounts WHERE id = 'owner'");

  startSecurityWorker(true);
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  const oldAdminCookie = signSecurityCookie({ kind: "admin", identityId: "audit_admin", credentialId: "audit-credential", passkeySessionEpoch: 1 });
  const oldIdentityCookie = signSecurityCookie({ kind: "identity", identityId, credentialId, passkeySessionEpoch: 1 });
  const statusAdminCookie = signSecurityCookie({ kind: "admin", identityId: statusAdminIdentityId, credentialId: statusAdminCredentialId, passkeySessionEpoch: 1 });
  assert.equal(await securityAdminAuthenticated(oldAdminCookie), true, "current-epoch Security admin cookie is accepted");
  assert.equal(await securityAdminAuthenticated(statusAdminCookie), true, "a live Security administrator cookie is accepted by status");
  await waitForAuditCount(statusAdminIdentityId, "session_resume", 1);
  const validStatusResumeCount = auditCount(statusAdminIdentityId, "session_resume");
  const statusCredentialRevoke = await securityAdminRequest(`/security/api/credentials/${statusAdminCredentialId}/revoke`, oldAdminCookie, {});
  assert.equal(statusCredentialRevoke.response.status, 200, "a live administrator can revoke the status-test credential through the HTTP API");
  assert.equal(await securityAdminAuthenticated(statusAdminCookie), false, "status rejects a revoked administrator credential");
  const revokedAdminApi = await securityAdminRequest("/security/api/credentials/missing-credential/revoke", statusAdminCookie, {});
  assert.equal(revokedAdminApi.response.status, 401, "a revoked administrator credential cannot use management APIs");
  await delay(200);
  assert.equal(auditCount(statusAdminIdentityId, "session_resume"), validStatusResumeCount,
    "status does not audit a revoked administrator cookie as a successful resume");
  runSecuritySql(`UPDATE security_credentials SET status = 'active', revoked_at = NULL WHERE credential_id = '${statusAdminCredentialId}';
    UPDATE security_identities SET status = 'disabled' WHERE id = '${statusAdminIdentityId}'`);
  assert.equal(await securityAdminAuthenticated(statusAdminCookie), false, "status rejects a disabled administrator Identity");
  const disabledAdminApi = await securityAdminRequest("/security/api/credentials/missing-credential/revoke", statusAdminCookie, {});
  assert.equal(disabledAdminApi.response.status, 401, "a disabled administrator Identity cannot use management APIs");
  await delay(200);
  assert.equal(auditCount(statusAdminIdentityId, "session_resume"), validStatusResumeCount,
    "status does not audit a disabled administrator cookie as a successful resume");
  runSecuritySql(`UPDATE security_identities SET status = 'active' WHERE id = '${statusAdminIdentityId}'`);
  runSecuritySql(`UPDATE security_identities SET is_security_admin = 0 WHERE id = '${statusAdminIdentityId}'`);
  assert.equal(await securityAdminAuthenticated(statusAdminCookie), false, "status rejects a live Identity after Security administrator privilege is removed");
  await delay(200);
  assert.equal(auditCount(statusAdminIdentityId, "session_resume"), validStatusResumeCount,
    "status does not audit a non-administrator cookie as a successful resume");
  runSecuritySql(`UPDATE security_identities SET is_security_admin = 1 WHERE id = '${statusAdminIdentityId}'`);
  assert.equal(await securityIdentityHandoff(oldIdentityCookie), 200, "current-epoch Security identity cookie is accepted");
  assert.deepEqual(await cloudAuthenticationCredentialIds(), [readinessCredentialA, primaryCredentialId].sort(),
    "Cloud login candidates include a folder-ready member and the envelope-free primary subadministrator, but not an unready folder credential");
  const securityOptions = await readAuthenticationOptions("security");
  assert.equal(typeof securityOptions.extensions?.prf?.evalByCredential?.["audit-credential"]?.first, "string",
    "Security authentication PRF input crosses HTTP as Base64URL text");
  assert.equal(securityOptions.extensions.prf.evalByCredential["audit-credential"].first, "dGVzdC1wcmYtc2FsdA",
    "Security authentication preserves the stored PRF salt bytes");
  const cloudOptions = await readAuthenticationOptions("cloud");
  assert.equal(typeof cloudOptions.extensions?.prf?.evalByCredential?.[readinessCredentialA]?.first, "string",
    "T-Cloud authentication PRF input crosses HTTP as Base64URL text");
  assert.equal(cloudOptions.extensions.prf.evalByCredential[readinessCredentialA].first, "c2FsdC1h",
    "T-Cloud authentication preserves the credential PRF salt bytes");
  assert.equal((await readAuthenticationOptions("diary")).extensions?.prf, undefined,
    "Diary authentication does not request a T-Cloud-only PRF evaluation");
  assert.equal((await readAuthenticationOptions("billing")).extensions?.prf, undefined,
    "Billing authentication does not request a T-Cloud-only PRF evaluation");
  const readinessCookieA = signSecurityCookie({ kind: "identity", identityId: readinessIdentityId, credentialId: readinessCredentialA, passkeySessionEpoch: 1 });
  const readinessCookieB = signSecurityCookie({ kind: "identity", identityId: readinessIdentityId, credentialId: readinessCredentialB, passkeySessionEpoch: 1 });
  assert.equal(await securityCloudHandoff(readinessCookieA), 200, "credential A can create a handoff for its delegated folder");
  assert.equal(await securityCloudHandoff(readinessCookieB), 403, "credential B cannot select an active link without its own envelope");
  await startServiceWorkers(true);
  stopSecurityWorker();
  startSecurityWorker(true);
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  let readinessDetail = await securityIdentityDetail(readinessIdentityId, oldAdminCookie);
  const readinessCandidateB = readinessDetail.approvalCandidates.find((item) => item.credentialId === readinessCredentialB);
  assert.equal(readinessCandidateB?.cloudPendingCount, 1,
    "the second credential is shown as pending Cloud delegation");
  const serviceBindingFolder = readinessCandidateB.cloudApproval.folders[0].folder;
  assert.equal(serviceBindingFolder.adminWrappedKey, serviceBindingFolderPackage.payload.adminWrappedKey,
    "the Cloud Service Binding returns requireFolder's camelCase administrator wrap without dropping it");
  const serviceBindingFolderKey = await TRoomCrypto.unlockFolderAsAdmin(serviceBindingFolder, serviceBindingAdminKeys.privateKey);
  const serviceBindingDelegatedWrap = await TRoomCrypto.wrapFolderKeyForIdentity(serviceBindingFolderKey, serviceBindingRecipientPublicJwk);
  const serviceBindingDelegatedKey = await TRoomCrypto.unlockDelegatedFolderKey(serviceBindingRecipientKeys.privateKey, serviceBindingDelegatedWrap);
  assert.equal(await TRoomCrypto.decryptFolderName(serviceBindingFolder, serviceBindingDelegatedKey), cloudSelectedRootName,
    "the actual Service Binding record can be unwrapped by the administrator and rewrapped for the invited credential");
  const delegatedB = await approveCredentialCloudLink(readinessIdentityId, readinessCredentialB, oldAdminCookie, serviceBindingDelegatedWrap);
  assert.equal(delegatedB.tcloudPasskeyReady, true, "admin delegation activates credential B readiness without replacing the credential");
  assert.equal(queryText("security-worker", "security-db", `SELECT wrapped_key AS value FROM security_tcloud_key_envelopes
    WHERE credential_id = '${readinessCredentialB}' AND service_link_id = 'readiness-cloud-link' AND envelope_type = 'folder_key_rsa'`),
    serviceBindingDelegatedWrap, "approval persists the real delegated envelope returned by the browser crypto path");
  assert.deepEqual((await cloudAuthenticationCredentialIds()).sort(), [readinessCredentialA, readinessCredentialB, primaryCredentialId].sort(),
    "the second credential becomes a Cloud candidate only after delegation");
  assert.equal(await securityCloudHandoff(readinessCookieB), 200, "credential B can create a handoff after its own delegation");
  readinessDetail = await securityIdentityDetail(readinessIdentityId, oldAdminCookie);
  assert.equal(readinessDetail.approvalCandidates.some((item) => item.credentialId === readinessCredentialB), false);
  for (const malformed of ["%", "***", "a", "a.b.c", "e30.invalid-signature"]) {
    const response = await fetch("http://127.0.0.1:8810/security/api/status", { headers: { Cookie: `troom_security_admin=${malformed}` } });
    assert.equal(response.status, 200, `malformed Security cookie ${malformed} must not cause 500`);
    assert.equal((await response.json()).adminAuthenticated, false);
  }
  const identityCountBeforeUnlinkedLogin = queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_identities");
  const adminPasswordAuditBefore = serviceAuditCount(identityId, "diary", "password_login_success");
  const adminPasswordLogin = await loginDiary("main-admin@example.test", diaryAdminPassword);
  assert.equal(adminPasswordLogin.response.status, 200, JSON.stringify(adminPasswordLogin.body));
  assert.equal(serviceAuditCount(identityId, "diary", "password_login_success"), adminPasswordAuditBefore + 1,
    "Diary main-admin password login is present in Security D1 before the response is observed");
  assert.ok(adminPasswordLogin.cookie);

  const userPasswordAuditBefore = serviceAuditCount(identityId, "diary", "password_login_success");
  const userPasswordLogin = await loginDiary("sub@a-tanaka.jp", diaryUserPassword);
  assert.equal(userPasswordLogin.response.status, 200, JSON.stringify(userPasswordLogin.body));
  assert.equal(serviceAuditCount(identityId, "diary", "password_login_success"), userPasswordAuditBefore + 1,
    "a second Diary account linked to the same Identity updates that same Identity synchronously");
  assert.ok(userPasswordLogin.cookie);
  const loginAtBeforeResume = queryText("security-worker", "security-db",
    `SELECT last_login_at AS value FROM security_identities WHERE id = '${identityId}'`);
  const seenAtBeforeResume = queryText("security-worker", "security-db",
    `SELECT last_seen_at AS value FROM security_identities WHERE id = '${identityId}'`);
  const resumeAuditBefore = serviceAuditCount(identityId, "diary", "session_resume");
  await delay(5);
  const resumed = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/session`, {
    headers: { Cookie: `${services.diary.cookie}=${userPasswordLogin.cookie}` }
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).authenticated, true);
  assert.equal(serviceAuditCount(identityId, "diary", "session_resume"), resumeAuditBefore + 1,
    "saved Diary session resume is stored synchronously");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_active_sessions
    WHERE identity_id = '${identityId}' AND service = 'diary' AND service_account_id = 'main-user'
      AND auth_method = 'password' AND ended_at IS NULL`), 1,
  "a uniquely linked password session is tracked by its one-way identifier");
  assert.equal(queryText("security-worker", "security-db",
    `SELECT last_login_at AS value FROM security_identities WHERE id = '${identityId}'`), loginAtBeforeResume,
  "session resume never changes last_login_at");
  assert.ok(queryText("security-worker", "security-db",
    `SELECT last_seen_at AS value FROM security_identities WHERE id = '${identityId}'`) >= seenAtBeforeResume,
  "session resume advances only last_seen_at");
  const diaryLogout = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/logout`, {
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${services.diary.port}`, "Content-Type": "application/json", Cookie: `${services.diary.cookie}=${userPasswordLogin.cookie}` },
    body: "{}"
  });
  assert.equal(diaryLogout.status, 200);
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_active_sessions
    WHERE identity_id = '${identityId}' AND service = 'diary' AND service_account_id = 'main-user'
      AND auth_method = 'password' AND ended_at IS NULL`), 0,
  "explicit logout ends only the matching service session");
  assert.equal(queryText("security-worker", "security-db", `SELECT end_reason AS value FROM security_active_sessions
    WHERE identity_id = '${identityId}' AND service = 'diary' AND service_account_id = 'main-user'
      AND auth_method = 'password' ORDER BY updated_at DESC LIMIT 1`), "logout");

  const unlinkedAuditBefore = queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE service = 'diary' AND service_account_id = 'wife-admin' AND event_type = 'password_login_success'`);
  const unlinkedLogin = await loginDiary("wife@example.test", diaryWifePassword);
  assert.equal(unlinkedLogin.response.status, 200, JSON.stringify(unlinkedLogin.body));
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE service = 'diary' AND service_account_id = 'wife-admin' AND event_type = 'password_login_success'`), unlinkedAuditBefore + 1,
  "an unlinked account audit is retained without inventing an Identity");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE service = 'diary' AND service_account_id = 'wife-admin' AND event_type = 'password_login_success' AND identity_id IS NOT NULL`), 0,
  "an unlinked password account is not attached to the wrong Identity");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_identities"), identityCountBeforeUnlinkedLogin,
    "password audit resolution never auto-creates an Identity");

  const fallbackAuditBefore = serviceAuditCount(identityId, "diary", "password_login_success");
  runSecuritySql(`CREATE TRIGGER fail_synchronous_login_audit
    BEFORE INSERT ON security_audit_events
    WHEN NEW.event_type = 'password_login_success'
    BEGIN SELECT RAISE(ABORT, 'injected synchronous audit failure'); END`);
  const fallbackLogin = await loginDiary("main-admin@example.test", diaryAdminPassword);
  assert.equal(fallbackLogin.response.status, 200, "Security RPC failure must not reject a valid service login");
  assert.equal(serviceAuditCount(identityId, "diary", "password_login_success"), fallbackAuditBefore,
    "the injected Security D1 failure prevents the synchronous insert before Queue recovery");
  runSecuritySql("DROP TRIGGER fail_synchronous_login_audit");
  await waitForServiceAudit(identityId, "diary", "password_login_success", fallbackAuditBefore + 1);
  assert.equal(serviceAuditCount(identityId, "diary", "password_login_success"), fallbackAuditBefore + 1,
    "the same login event is recovered later through SECURITY_AUDIT Queue");

  const handoffCases = [
    { service: "diary", cookie: oldIdentityCookie, linkId: services.diary.linkId, accountId: services.diary.accountId, role: "user" },
    { service: "billing", cookie: oldIdentityCookie, linkId: services.billing.linkId, accountId: services.billing.accountId, role: "owner" },
    { service: "cloud", cookie: readinessCookieA, linkId: "readiness-cloud-link", accountId: "folder-member", role: "member", rootFolderId: cloudSelectedRootId }
  ];
  let memberCloudCookie = null;
  for (const expected of handoffCases) {
    const created = await createSecurityHandoff(expected.cookie, expected.service, expected.linkId);
    assert.equal(created.response.status, 200, `${expected.service} handoff creation: ${JSON.stringify(created.body)}`);
    assert.ok(typeof created.body.handoffToken === "string" && created.body.handoffToken.length >= 32,
      `${expected.service} returns a non-empty one-time handoff token`);
    assertPlainPublicLink(created.body.link, expected);
    assert.equal(containsThenable(created.body), false, `${expected.service} handoff JSON contains no Promise or thenable`);
    assertNoPlaintextSecrets(created.body.link);
    if (expected.service === "cloud") {
      assert.equal(created.body.link.rootFolderId, expected.rootFolderId);
      assert.match(created.body.link.scopeLabel, /Security連携テスト/);
      assert.equal(JSON.stringify(created.body).includes("prfOutput"), false);
      assert.equal(JSON.stringify(created.body).includes("privateKey"), false);
      assert.equal(JSON.stringify(created.body).includes("folderKey"), false);
      assert.equal(JSON.stringify(created.body).includes("fileKey"), false);
    }
    const auditIdentity = expected.service === "cloud" ? readinessIdentityId : identityId;
    const auditBefore = serviceAuditCount(auditIdentity, expected.service, "passkey_login_success");
    const redeemed = await redeemServiceHandoff(expected.service, created.body.handoffToken);
    assert.equal(redeemed.response.status, 200, `${expected.service} redeems the handoff once: ${JSON.stringify(redeemed.body)}`);
    assert.equal(serviceAuditCount(auditIdentity, expected.service, "passkey_login_success"), auditBefore + 1,
      `${expected.service} passkey login is stored synchronously before its response is observed`);
    assert.ok(redeemed.cookie, `${expected.service} issues a service session cookie`);
    assert.equal(decodeSignedPayload(redeemed.cookie).serviceLinkId, expected.linkId,
      `${expected.service} session keeps the selected service link ID`);
    if (expected.service === "cloud") {
      memberCloudCookie = redeemed.cookie;
      await assertCloudFolderAccess(redeemed.cookie, cloudChildId, 200,
        "selecting a top folder includes its child folder");
      await assertCloudFolderAccess(redeemed.cookie, cloudGrandchildId, 200,
        "selecting a top folder includes its grandchild folder");
      await assertCloudFolderAccess(redeemed.cookie, cloudUnselectedRootId, 403,
        "an unselected top folder stays outside the linked scope");
    }
    const replay = await redeemServiceHandoff(expected.service, created.body.handoffToken);
    assert.equal(replay.response.status, 401, `${expected.service} rejects a second handoff redemption`);
  }
  assert.ok(memberCloudCookie, "the folder-member handoff issues a Cloud session");
  await assertFolderMemberApiScope(memberCloudCookie);

  const diaryChoiceRequired = await createSecurityHandoff(oldIdentityCookie, "diary", null);
  assert.equal(diaryChoiceRequired.response.status, 409,
    "two active Diary links require an explicit administrator or ordinary-user choice");
  const diaryAdminChoice = await createSecurityHandoff(oldIdentityCookie, "diary", diaryAdminLinkId);
  const diaryUserChoice = await createSecurityHandoff(oldIdentityCookie, "diary", services.diary.linkId);
  assert.equal(diaryAdminChoice.response.status, 200, JSON.stringify(diaryAdminChoice.body));
  assert.equal(diaryUserChoice.response.status, 200, JSON.stringify(diaryUserChoice.body));
  assert.equal(diaryAdminChoice.body.link.accountId, "main-admin");
  assert.equal(diaryAdminChoice.body.link.roleLabel, "管理者・全体管理");
  assert.equal(diaryUserChoice.body.link.accountId, "main-user");
  assert.equal(diaryUserChoice.body.link.roleLabel, "一般ユーザー");
  assert.match(diaryAdminChoice.body.link.displayLabel, /田中宏知.*管理者・全体管理/);
  assert.match(diaryUserChoice.body.link.displayLabel, /田中宏知.*一般ユーザー/);
  const redeemedDiaryAdminChoice = await redeemServiceHandoff("diary", diaryAdminChoice.body.handoffToken);
  const redeemedDiaryUserChoice = await redeemServiceHandoff("diary", diaryUserChoice.body.handoffToken);
  assert.equal(redeemedDiaryAdminChoice.response.status, 200, JSON.stringify(redeemedDiaryAdminChoice.body));
  assert.equal(redeemedDiaryUserChoice.response.status, 200, JSON.stringify(redeemedDiaryUserChoice.body));
  const diaryAdminChoicePayload = decodeSignedPayload(redeemedDiaryAdminChoice.cookie);
  const diaryUserChoicePayload = decodeSignedPayload(redeemedDiaryUserChoice.cookie);
  assert.equal(diaryAdminChoicePayload.serviceAccountId, "main-admin");
  assert.equal(diaryAdminChoicePayload.role, "admin");
  assert.equal(redeemedDiaryAdminChoice.body.isGlobalOwner, true);
  assert.equal(diaryUserChoicePayload.serviceAccountId, "main-user");
  assert.equal(diaryUserChoicePayload.role, "user");
  assert.equal(redeemedDiaryUserChoice.body.isGlobalOwner, false);
  assert.equal(redeemedDiaryUserChoice.body.activeHouseholdId, "tanaka-household");
  for (const permission of ["canManageEntries", "canViewTrash", "canPermanentlyDelete", "canViewInvestment"]) {
    assert.equal(redeemedDiaryUserChoice.body[permission], true,
      `main-user handoff preserves the existing ${permission} permission`);
  }
  const ordinaryUserHouseholdSwitch = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/households/select`, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${services.diary.port}`,
      "Content-Type": "application/json",
      "X-Diary-Request": "1",
      Cookie: `${services.diary.cookie}=${redeemedDiaryUserChoice.cookie}`
    },
    body: JSON.stringify({ householdId: "chiharu-household" })
  });
  assert.equal(ordinaryUserHouseholdSwitch.status, 403,
    "selecting main-user keeps the existing personal household boundary instead of inheriting global-owner scope");

  const adminHandoff = await createSecurityHandoff(readinessCookieA, "cloud", "readiness-cloud-admin-link");
  assert.equal(adminHandoff.response.status, 200, JSON.stringify(adminHandoff.body));
  assert.equal(adminHandoff.body.link.role, "admin", "the same Identity may explicitly select its Cloud administrator link");
  assert.equal(adminHandoff.body.link.rootFolderId, null);
  assert.ok(adminHandoff.body.tcloudKey?.admin_private_prf, "the administrator link returns only its credential-specific encrypted envelope");
  const redeemedAdmin = await redeemServiceHandoff("cloud", adminHandoff.body.handoffToken);
  assert.equal(redeemedAdmin.response.status, 200, JSON.stringify(redeemedAdmin.body));
  const adminCloudPayload = decodeSignedPayload(redeemedAdmin.cookie);
  const memberCloudPayload = decodeSignedPayload(memberCloudCookie);
  assert.equal(adminCloudPayload.role, "admin");
  assert.equal(adminCloudPayload.rootFolderId, null);
  assert.equal(memberCloudPayload.role, "member");
  assert.equal(memberCloudPayload.rootFolderId, cloudSelectedRootId);
  await assertCloudFolderAccess(redeemedAdmin.cookie, cloudUnselectedRootId, 200,
    "the explicitly selected administrator link retains full Cloud scope");
  await assertCloudFolderAccess(memberCloudCookie, cloudUnselectedRootId, 403,
    "selecting folder-member never inherits administrator scope from the same Identity");
  await waitForServiceAudit(identityId, "diary", "passkey_login_success", 3);
  await waitForServiceAudit(identityId, "billing", "passkey_login_success", 1);
  await waitForServiceAudit(readinessIdentityId, "cloud", "passkey_login_success", 2);
  assert.equal(serviceAuditCount(identityId, "diary", "passkey_login_success"), 3,
    "Diary emits one service login completion event for each redeemed account choice");
  assert.equal(serviceAuditCount(identityId, "billing", "passkey_login_success"), 1,
    "Billing emits one service login completion event for one redeemed handoff");
  assert.equal(serviceAuditCount(readinessIdentityId, "cloud", "passkey_login_success"), 2,
    "T-Cloud audits the independently selected member and administrator handoffs");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(DISTINCT service) AS value FROM security_active_sessions
    WHERE identity_id = '${identityId}' AND service IN ('diary', 'billing') AND auth_method = 'passkey' AND ended_at IS NULL`), 2,
  "one Identity can remain logged in to multiple services independently");
  const handoffLastLogin = queryText("security-worker", "security-db",
    `SELECT last_login_at AS value FROM security_identities WHERE id = '${identityId}'`);
  const handoffLastSeen = queryText("security-worker", "security-db",
    `SELECT last_seen_at AS value FROM security_identities WHERE id = '${identityId}'`);
  assert.ok(handoffLastLogin.endsWith("Z"), "a completed service login records the latest Identity login as UTC ISO");
  assert.ok(handoffLastSeen >= handoffLastLogin,
    "a completed service login also records a normal Identity access without moving last_seen_at backwards");
  const freshAdminCookie = signSecurityCookie({
    kind: "admin", identityId: "audit_admin", credentialId: "audit-credential",
    passkeySessionEpoch: 1, authenticatedAt: Math.floor(Date.now() / 1000)
  });
  const serviceRegistryResponse = await securityAdminRequest("/security/api/services", freshAdminCookie);
  assert.equal(serviceRegistryResponse.response.status, 200, JSON.stringify(serviceRegistryResponse.body));
  const diaryTargets = serviceRegistryResponse.body.services.find((service) => service.id === "diary")?.targets || [];
  assert.ok(diaryTargets.some((target) => target.accountId === "main-admin" && /田中宏知.*管理者/.test(target.displayLabel)),
    "Diary provider returns the existing administrator with a human label and role");
  assert.ok(diaryTargets.some((target) => target.accountId === "main-user" && /田中宏知.*一般ユーザー/.test(target.displayLabel)),
    "Diary provider distinguishes the existing ordinary account with a human label and role");
  const billingTargets = serviceRegistryResponse.body.services.find((service) => service.id === "billing")?.targets || [];
  assert.ok(billingTargets.some((target) => target.accountId === "owner" && target.privileged === true),
    "Billing provider returns the active owner as a privileged human-labelled candidate");
  const cloudTargets = serviceRegistryResponse.body.services.find((service) => service.id === "cloud")?.targets || [];
  assert.ok(cloudTargets.some((target) => target.rootFolderId === cloudSelectedRootId && target.displayLabel === cloudSelectedRootName),
    "T-Cloud provider returns a live top-folder name instead of requiring a numeric ID");
  assert.ok(cloudTargets.some((target) => target.rootFolderId === cloudUnselectedRootId && target.displayLabel === cloudUnselectedRootName),
    "T-Cloud provider returns each selectable top-level folder");
  assert.equal(cloudTargets.some((target) => [cloudChildId, cloudGrandchildId].includes(target.rootFolderId)), false,
    "T-Cloud provider excludes child and grandchild folders from new link choices");
  assert.ok(cloudTargets.every((target) => target.accountId === "folder-member"),
    "T-Cloud admin and subadmin never appear in ordinary service-link candidates");
  const legacyNestedDetail = await securityIdentityDetail(legacyNestedIdentityId, oldAdminCookie);
  const legacyNestedLink = legacyNestedDetail.links.find((link) => link.id === "legacy-nested-cloud-link");
  assert.equal(legacyNestedLink.folderUnavailable, false, "an existing nested-folder link remains manageable");
  assert.equal(legacyNestedLink.display_label, `${cloudSelectedRootName} / ${cloudChildName}`,
    "an existing nested-folder link keeps its original scope and resolves its live path");

  const lifecycleExpiry = Math.floor(Date.now() / 1000) + 3600;
  runSecuritySql(`
    INSERT INTO security_identities (id, display_name, status) VALUES ('${disabledLifecycleIdentityId}', 'Identity Disable Test', 'active');
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_enabled, prf_salt, status, approved_at)
      VALUES ('${disabledLifecycleCredentialId}', '${disabledLifecycleIdentityId}', 'disable-public-key', 1, 'ZGlzYWJsZS1wcmYtc2FsdA', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('${disabledLifecycleCloudLinkId}', '${disabledLifecycleIdentityId}', 'cloud', 'folder-member', ${cloudSelectedRootId}, 'Disable Cloud', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('${disabledLifecycleDiaryLinkId}', '${disabledLifecycleIdentityId}', 'diary', 'disable-exclusive-account', 'Disable Diary', 'pending');
    INSERT INTO security_invitations
      (id, identity_id, token_hash, link_set_hash, expires_at, status)
      VALUES ('identity-disable-invite', '${disabledLifecycleIdentityId}', 'identity-disable-invite-hash', 'identity-disable-links', ${lifecycleExpiry}, 'active');
    INSERT INTO security_setup_sessions
      (id, token_hash, identity_id, credential_id, status, expires_at)
      VALUES ('identity-disable-setup', 'identity-disable-setup-hash', '${disabledLifecycleIdentityId}', '${disabledLifecycleCredentialId}', 'active', ${lifecycleExpiry});
    INSERT INTO security_challenges
      (id, purpose, challenge_hash, identity_id, expires_at)
      VALUES ('identity-disable-challenge', 'authentication', 'identity-disable-challenge-hash', '${disabledLifecycleIdentityId}', ${lifecycleExpiry});
    INSERT INTO security_handoffs
      (id, token_hash, identity_id, service_link_id, credential_id, expires_at, session_epoch)
      VALUES ('identity-disable-handoff', 'identity-disable-handoff-hash', '${disabledLifecycleIdentityId}', '${disabledLifecycleCloudLinkId}', '${disabledLifecycleCredentialId}', ${lifecycleExpiry}, 1);
    INSERT INTO security_tcloud_client_vaults
      (credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
      VALUES ('${disabledLifecycleCredentialId}', '${disabledLifecycleIdentityId}', '{"kty":"RSA"}', 'identity-disable-fingerprint', 'identity-disable-private', 'identity-disable-iv');
    INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
      VALUES ('identity-disable-folder-envelope', '${disabledLifecycleIdentityId}', '${disabledLifecycleCredentialId}', '${disabledLifecycleCloudLinkId}', 'folder_key_rsa', 'identity-disable-wrapped');
  `);
  const disabledLifecycleIdentityCookie = signSecurityCookie({
    kind: "identity", identityId: disabledLifecycleIdentityId, credentialId: disabledLifecycleCredentialId, passkeySessionEpoch: 1
  });
  const disabledLifecycleHandoff = await createSecurityHandoff(disabledLifecycleIdentityCookie, "cloud", disabledLifecycleCloudLinkId);
  assert.equal(disabledLifecycleHandoff.response.status, 200,
    "the lifecycle fixture can issue a handoff before Identity disable");
  const disabledLifecycleCloudLogin = await redeemServiceHandoff("cloud", disabledLifecycleHandoff.body.handoffToken);
  assert.equal(disabledLifecycleCloudLogin.response.status, 200, JSON.stringify(disabledLifecycleCloudLogin.body));
  assert.ok(disabledLifecycleCloudLogin.cookie, "the lifecycle fixture receives a real Cloud passkey session");
  await assertSingleAccess("cloud", disabledLifecycleCloudLogin.cookie, true, "Identity session before disable");
  const disableLifecycle = await securityAdminRequest(`/security/api/identities/${disabledLifecycleIdentityId}/disable`, freshAdminCookie, {});
  assert.equal(disableLifecycle.response.status, 200, JSON.stringify(disableLifecycle.body));
  assert.equal(disableLifecycle.body.identityDisabled, true);
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_identities WHERE id = '${disabledLifecycleIdentityId}'`), "disabled");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_credentials
    WHERE identity_id = '${disabledLifecycleIdentityId}' AND status = 'revoked' AND revoked_at IS NOT NULL`), 1,
    "active and pending credentials are revoked with a timestamp");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_service_links
    WHERE identity_id = '${disabledLifecycleIdentityId}' AND status = 'disabled'`), 2,
    "active and pending service links are disabled");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_invitations WHERE id = 'identity-disable-invite'"), "revoked");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_setup_sessions WHERE id = 'identity-disable-setup'"), "expired");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_challenges
    WHERE identity_id = '${disabledLifecycleIdentityId}' AND consumed_at IS NOT NULL`), 1);
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_handoffs
    WHERE identity_id = '${disabledLifecycleIdentityId}' AND consumed_at IS NOT NULL`), 2,
    "pre-existing and just-issued handoffs are invalidated");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_tcloud_client_vaults
    WHERE identity_id = '${disabledLifecycleIdentityId}'`), 1, "client vault history is retained");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_tcloud_key_envelopes
    WHERE identity_id = '${disabledLifecycleIdentityId}'`), 1, "folder envelope history is retained");
  assert.equal(auditCount(disabledLifecycleIdentityId, "identity_disabled"), 1, "Identity disable is audited atomically");
  const disabledIdentityList = await securityAdminRequest("/security/api/identities", freshAdminCookie);
  assert.equal(disabledIdentityList.body.identities.some((identity) => identity.id === disabledLifecycleIdentityId), false,
    "disabled Identities disappear from the normal user list");
  assert.equal(disabledIdentityList.body.auditIdentities.some((identity) => identity.id === disabledLifecycleIdentityId), true,
    "a disabled Identity with retained audit history remains available to the audit filter");
  assert.equal((await createSecurityHandoff(disabledLifecycleIdentityCookie, "cloud", disabledLifecycleCloudLinkId)).response.status, 401,
    "the old Security Identity cookie is rejected on its next access");
  await assertSingleAccess("cloud", disabledLifecycleCloudLogin.cookie, false, "disabled Identity service session");
  const passwordSessionAfterDisable = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/session`, {
    headers: { Cookie: `${services.diary.cookie}=${userPasswordLogin.cookie}` }
  });
  assert.equal(passwordSessionAfterDisable.status, 200, "Identity disable does not affect an existing password session");
  assert.equal((await passwordSessionAfterDisable.json()).authenticated, true);
  const disablePrimary = await securityAdminRequest("/security/api/identities/primary-admin/disable", freshAdminCookie, {});
  assert.equal(disablePrimary.response.status, 409, "the primary administrator cannot be disabled");
  runSecuritySql(`
    INSERT INTO security_identities (id, display_name, status) VALUES ('identity_disable_replacement', 'Identity Disable Replacement', 'invited');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('identity-disable-diary-replacement', 'identity_disable_replacement', 'diary', 'disable-exclusive-account', 'Disable Diary Replacement', 'pending');
  `);
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_service_links WHERE id = 'identity-disable-diary-replacement'"), "pending",
    "a disabled exclusive service link does not block a fresh Identity link");

  const invitationExpiryCases = [
    { label: "1 hour", body: { expiresIn: 3600 }, expectedSeconds: 3600 },
    { label: "6 hours", body: { expiresIn: 21600 }, expectedSeconds: 21600 },
    { label: "24 hours", body: { expiresIn: 86400 }, expectedSeconds: 86400 },
    { label: "3 days", body: { expiresIn: 259200 }, expectedSeconds: 259200 },
    { label: "7 days", body: { expiresIn: 604800 }, expectedSeconds: 604800 },
    { label: "custom", body: { expiresAt: Math.floor(Date.now() / 1000) + 172923 }, expectedSeconds: null }
  ];
  for (const [index, expiryCase] of invitationExpiryCases.entries()) {
    const requestedAt = Math.floor(Date.now() / 1000);
    const created = await securityAdminRequest("/security/api/identities", freshAdminCookie, {
      displayName: `Invitation Expiry Contract ${index + 1}`,
      ...expiryCase.body,
      links: [{ service: "cloud", accountId: "folder-member", rootFolderId: cloudUnselectedRootId }]
    });
    assert.equal(created.response.status, 201, `${expiryCase.label}: ${JSON.stringify(created.body)}`);
    assert.equal(typeof created.body.expiresAt, "number", `${expiryCase.label}: create response keeps Unix seconds numeric`);
    if (expiryCase.expectedSeconds) {
      assert.ok(created.body.expiresAt >= requestedAt + expiryCase.expectedSeconds
        && created.body.expiresAt <= Math.floor(Date.now() / 1000) + expiryCase.expectedSeconds + 1,
      `${expiryCase.label}: preset expiry is calculated from the request time`);
    } else {
      assert.equal(created.body.expiresAt, expiryCase.body.expiresAt, "custom expiry is preserved exactly");
    }
    const detail = await securityAdminRequest(`/security/api/identities/${created.body.identityId}`, freshAdminCookie);
    assert.equal(detail.response.status, 200, `${expiryCase.label}: ${JSON.stringify(detail.body)}`);
    assert.equal(typeof detail.body.invitations[0].expires_at, "number", `${expiryCase.label}: detail API keeps Unix seconds numeric`);
    assert.equal(detail.body.invitations[0].expires_at, created.body.expiresAt, `${expiryCase.label}: detail expiry equals create response`);
  }

  const dashboardBeforeCancelledInvite = (await securityAdminRequest("/security/api/dashboard", freshAdminCookie)).body;
  const cancelledInvite = await securityAdminRequest("/security/api/identities", freshAdminCookie, {
    displayName: "Cancelled Invitation Test",
    expiresIn: 86400,
    links: [{ service: "diary", accountId: "chiharu-admin", rootFolderId: null }]
  });
  assert.equal(cancelledInvite.response.status, 201, JSON.stringify(cancelledInvite.body));
  const cancelledIdentityId = cancelledInvite.body.identityId;
  const cancelledInvitationId = queryText("security-worker", "security-db",
    `SELECT id AS value FROM security_invitations WHERE identity_id = '${cancelledIdentityId}' AND status = 'active'`);
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_identities WHERE id = '${cancelledIdentityId}'`), "invited");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_service_links WHERE identity_id = '${cancelledIdentityId}'`), "pending");
  const revokeUnusedInvite = await securityAdminRequest(`/security/api/invitations/${cancelledInvitationId}/revoke`, freshAdminCookie, {});
  assert.equal(revokeUnusedInvite.response.status, 200, JSON.stringify(revokeUnusedInvite.body));
  assert.equal(revokeUnusedInvite.body.identityRetired, true, "the final unused invitation retires its never-registered Identity");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_invitations WHERE id = '${cancelledInvitationId}'`), "revoked");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_identities WHERE id = '${cancelledIdentityId}'`), "disabled");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_service_links WHERE identity_id = '${cancelledIdentityId}'`), "disabled");
  const identitiesAfterCancelledInvite = await securityAdminRequest("/security/api/identities", freshAdminCookie);
  assert.equal(identitiesAfterCancelledInvite.response.status, 200, JSON.stringify(identitiesAfterCancelledInvite.body));
  assert.equal(identitiesAfterCancelledInvite.body.identities.some((identity) => identity.id === cancelledIdentityId), false,
    "disabled invitation-only Identities are absent from the normal user list");
  const dashboardAfterCancelledInvite = (await securityAdminRequest("/security/api/dashboard", freshAdminCookie)).body;
  assert.equal(dashboardAfterCancelledInvite.invited, dashboardBeforeCancelledInvite.invited,
    "revoking the new invitation removes the retired Identity from the invited count");
  assert.equal(dashboardAfterCancelledInvite.noPasskey, dashboardBeforeCancelledInvite.noPasskey,
    "revoking the new invitation removes the retired Identity from the no-passkey count");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events WHERE identity_id = '${cancelledIdentityId}' AND event_type = 'invite_revoked'`), 1);
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events WHERE identity_id = '${cancelledIdentityId}' AND event_type = 'invited_identity_retired'`), 1);

  const multipleInvite = await securityAdminRequest("/security/api/identities", freshAdminCookie, {
    displayName: "Multiple Invitation Test",
    expiresIn: 86400,
    links: [{ service: "cloud", accountId: "folder-member", rootFolderId: cloudUnselectedRootId }]
  });
  assert.equal(multipleInvite.response.status, 201, JSON.stringify(multipleInvite.body));
  const multipleIdentityId = multipleInvite.body.identityId;
  const firstMultipleInvitationId = queryText("security-worker", "security-db",
    `SELECT id AS value FROM security_invitations WHERE identity_id = '${multipleIdentityId}' AND status = 'active'`);
  runSecuritySql(`INSERT INTO security_invitations
    (id, identity_id, token_hash, link_set_hash, expires_at, status, created_by_identity_id)
    SELECT 'second-multiple-invite', identity_id, 'second-multiple-token', link_set_hash, expires_at, 'active', created_by_identity_id
    FROM security_invitations WHERE id = '${firstMultipleInvitationId}'`);
  const revokeOneOfMultiple = await securityAdminRequest(`/security/api/invitations/${firstMultipleInvitationId}/revoke`, freshAdminCookie, {});
  assert.equal(revokeOneOfMultiple.response.status, 200, JSON.stringify(revokeOneOfMultiple.body));
  assert.equal(revokeOneOfMultiple.body.identityRetired, false, "another active invitation keeps the invited Identity visible");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_identities WHERE id = '${multipleIdentityId}'`), "invited");
  const revokeLastMultiple = await securityAdminRequest("/security/api/invitations/second-multiple-invite/revoke", freshAdminCookie, {});
  assert.equal(revokeLastMultiple.response.status, 200, JSON.stringify(revokeLastMultiple.body));
  assert.equal(revokeLastMultiple.body.identityRetired, true, "the last active invitation retires the untouched Identity");

  runSecuritySql(`INSERT INTO security_identities (id, display_name, status) VALUES ('pending-invite-cancel', 'Pending Approval', 'pending_approval');
    INSERT INTO security_credentials (credential_id, identity_id, public_key, prf_salt, status)
      VALUES ('pending-invite-credential', 'pending-invite-cancel', 'public', 'salt', 'pending');
    INSERT INTO security_service_links (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('pending-invite-link', 'pending-invite-cancel', 'cloud', 'folder-member', 'Pending Cloud', 'pending');
    INSERT INTO security_invitations (id, identity_id, token_hash, link_set_hash, expires_at, status)
      VALUES ('pending-invite', 'pending-invite-cancel', 'pending-invite-token', 'pending-invite-hash', 4102444800, 'active')`);
  const revokePendingApproval = await securityAdminRequest("/security/api/invitations/pending-invite/revoke", freshAdminCookie, {});
  assert.equal(revokePendingApproval.response.status, 200, JSON.stringify(revokePendingApproval.body));
  assert.equal(revokePendingApproval.body.identityRetired, false);
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_identities WHERE id = 'pending-invite-cancel'"), "pending_approval");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_credentials WHERE credential_id = 'pending-invite-credential'"), "pending");

  const activeReinvite = await securityAdminRequest(`/security/api/identities/${identityId}/reinvite`, freshAdminCookie, { expiresIn: 86400 });
  assert.equal(activeReinvite.response.status, 201, JSON.stringify(activeReinvite.body));
  const activeReinviteId = queryText("security-worker", "security-db",
    `SELECT id AS value FROM security_invitations WHERE identity_id = '${identityId}' AND status = 'active'`);
  const revokeActiveReinvite = await securityAdminRequest(`/security/api/invitations/${activeReinviteId}/revoke`, freshAdminCookie, {});
  assert.equal(revokeActiveReinvite.response.status, 200, JSON.stringify(revokeActiveReinvite.body));
  assert.equal(revokeActiveReinvite.body.identityRetired, false, "cancelling a reinvite never retires an active user");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_identities WHERE id = '${identityId}'`), "active");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_credentials WHERE credential_id = '${credentialId}'`), "active");
  const activeAfterReinviteCancellation = await createSecurityHandoff(oldIdentityCookie, "billing", services.billing.linkId);
  assert.equal(activeAfterReinviteCancellation.response.status, 200, JSON.stringify(activeAfterReinviteCancellation.body));

  const primaryReinvite = await securityAdminRequest("/security/api/identities/primary-admin/reinvite", freshAdminCookie, { expiresIn: 86400 });
  assert.equal(primaryReinvite.response.status, 201, JSON.stringify(primaryReinvite.body));
  const primaryReinviteId = queryText("security-worker", "security-db",
    "SELECT id AS value FROM security_invitations WHERE identity_id = 'primary-admin' AND status = 'active'");
  const revokePrimaryReinvite = await securityAdminRequest(`/security/api/invitations/${primaryReinviteId}/revoke`, freshAdminCookie, {});
  assert.equal(revokePrimaryReinvite.response.status, 200, JSON.stringify(revokePrimaryReinvite.body));
  assert.equal(revokePrimaryReinvite.body.identityRetired, false, "the primary administrator is never auto-retired");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_identities WHERE id = 'primary-admin'"), "active");

  for (const accountId of ["admin", "subadmin"]) {
    const tampered = await securityAdminRequest("/security/api/identities/primary-admin/links", freshAdminCookie, {
      links: [{ service: "cloud", accountId, rootFolderId: null }]
    });
    assert.equal(tampered.response.status, 403, `direct API tampering cannot grant T-Cloud ${accountId}`);
  }
  const nonCloudRoot = await securityAdminRequest("/security/api/identities/primary-admin/links", freshAdminCookie, {
    links: [{ service: "diary", accountId: "main-user", rootFolderId: cloudSelectedRootId }]
  });
  assert.equal(nonCloudRoot.response.status, 400, "a non-Cloud link cannot carry a T-Cloud folder ID");
  const nestedCloudRoot = await securityAdminRequest("/security/api/identities/primary-admin/links", freshAdminCookie, {
    links: [{ service: "cloud", accountId: "folder-member", rootFolderId: cloudChildId }]
  });
  assert.equal(nestedCloudRoot.response.status, 400,
    "direct API tampering cannot create a new link from a non-top-level Cloud folder");
  const protectedCore = await securityAdminRequest("/security/api/service-links/primary-admin-cloud-link", freshAdminCookie, {});
  assert.equal(protectedCore.response.status, 409, "the primary administrator core T-Cloud link cannot be removed");
  const protectedSubadminCore = await securityAdminRequest("/security/api/service-links/primary-admin-cloud-subadmin-link", freshAdminCookie, {});
  assert.equal(protectedSubadminCore.response.status, 409, "the primary subadministrator core T-Cloud link cannot be removed");
  const stalePrivileged = await securityAdminRequest("/security/api/identities/primary-admin/links", oldAdminCookie, {
    links: [{ service: "diary", accountId: "chiharu-admin", rootFolderId: null }]
  });
  assert.equal(stalePrivileged.response.status, 428, "a privileged Diary account requires a fresh administrator passkey");
  const freshPrivileged = await securityAdminRequest("/security/api/identities/primary-admin/links", freshAdminCookie, {
    links: [{ service: "diary", accountId: "chiharu-admin", rootFolderId: null }]
  });
  assert.equal(freshPrivileged.response.status, 200, JSON.stringify(freshPrivileged.body));
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_service_links WHERE identity_id = 'primary-admin' AND service = 'diary' AND service_account_id = 'chiharu-admin' AND status != 'disabled'"), "active",
    "the exclusive Diary account can be linked again after the unused invitation was retired");
  assert.equal(queryText("security-worker", "security-db", `SELECT status AS value FROM security_service_links WHERE identity_id = '${cancelledIdentityId}' AND service = 'diary' AND service_account_id = 'chiharu-admin'`), "disabled",
    "the old link remains as a permanent disabled marker");
  assert.notEqual(queryText("security-worker", "security-db", "SELECT id AS value FROM security_service_links WHERE identity_id = 'primary-admin' AND service = 'diary' AND service_account_id = 'chiharu-admin' AND status = 'active'"),
    queryText("security-worker", "security-db", `SELECT id AS value FROM security_service_links WHERE identity_id = '${cancelledIdentityId}' AND service = 'diary' AND service_account_id = 'chiharu-admin'`),
    "relinking uses a fresh service-link ID instead of reviving the disabled marker");
  const exclusiveConflict = await securityAdminRequest(`/security/api/identities/${readinessIdentityId}/links`, freshAdminCookie, {
    links: [{ service: "diary", accountId: "main-user", rootFolderId: null }]
  });
  assert.equal(exclusiveConflict.response.status, 409,
    "the narrow primary-admin alias does not allow a third Identity to claim the exclusive Diary account");
  const sharedCloud = await securityAdminRequest("/security/api/identities/primary-admin/links", freshAdminCookie, {
    links: [
      { service: "cloud", accountId: "folder-member", rootFolderId: cloudSelectedRootId },
      { service: "cloud", accountId: "folder-member", rootFolderId: cloudUnselectedRootId }
    ]
  });
  assert.equal(sharedCloud.response.status, 200, JSON.stringify(sharedCloud.body));
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_service_links WHERE service = 'cloud' AND service_account_id = 'folder-member' AND cloud_root_folder_id = ${cloudSelectedRootId} AND status IN ('pending', 'active')`), 3,
    "a validated Cloud folder link is accepted in pending state and remains shareable");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_service_links WHERE identity_id = 'primary-admin' AND service = 'cloud' AND service_account_id = 'folder-member' AND cloud_root_folder_id IN (${cloudSelectedRootId}, ${cloudUnselectedRootId}) AND status IN ('pending', 'active')`), 2,
    "multiple top-level Cloud folders can be linked in one operation");
  runSecuritySql(`CREATE TRIGGER fail_credential_revoke_audit
    BEFORE INSERT ON security_audit_events
    WHEN NEW.event_type = 'passkey_revoked'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
  const failedAtomicRevoke = await fetch("http://127.0.0.1:8810/security/api/credentials/audit-credential/revoke", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_admin=${oldAdminCookie}`
    }
  });
  assert.equal(failedAtomicRevoke.status, 500, "injected audit failure must fail the operation");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_credentials WHERE credential_id = 'audit-credential'"), "active",
    "D1 batch must roll back credential revoke when its audit INSERT fails");
  runSecuritySql("DROP TRIGGER fail_credential_revoke_audit");
  const longCredentialId = Buffer.alloc(1023, 23).toString("base64url");
  runSecuritySql(`INSERT INTO security_credentials
    (credential_id, identity_id, public_key, prf_salt, status, approved_at)
    VALUES ('${longCredentialId}', 'audit_admin', 'long-public-key', 'long-prf-salt', 'active', CURRENT_TIMESTAMP)`);
  const longCredentialRevoke = await fetch(`http://127.0.0.1:8810/security/api/credentials/${longCredentialId}/revoke`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_admin=${oldAdminCookie}`
    }
  });
  assert.equal(longCredentialRevoke.status, 200, "a valid 1023-byte WebAuthn credential ID can be revoked");
  const oversizedCredentialId = Buffer.alloc(1024, 23).toString("base64url");
  const oversizedCredentialRevoke = await fetch(`http://127.0.0.1:8810/security/api/credentials/${oversizedCredentialId}/revoke`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_admin=${oldAdminCookie}` }
  });
  assert.equal(oversizedCredentialRevoke.status, 400, "a credential ID above the WebAuthn 1023-byte limit is rejected");

  const lostPrimarySetupToken = "lost-primary-setup-token-12345678901234567890";
  const lostPrimarySetupHash = createHash("sha256").update(lostPrimarySetupToken).digest("base64url");
  runSecuritySql(`INSERT INTO security_setup_sessions
    (id, token_hash, identity_id, credential_id, expires_at)
    VALUES ('lost-primary-setup', '${lostPrimarySetupHash}', 'primary-admin', '${primaryCredentialId}', ${Math.floor(Date.now() / 1000) + 3600})`);
  const primaryAdminCookie = signSecurityCookie({ kind: "admin", identityId: "primary-admin", credentialId: primaryCredentialId, passkeySessionEpoch: 1 });
  const primaryIdentityCookie = signSecurityCookie({ kind: "identity", identityId: "primary-admin", credentialId: primaryCredentialId, passkeySessionEpoch: 1 });
  const primaryBeforeResume = await readSetupStatusWithCookies(`troom_security_admin=${primaryAdminCookie}`);
  assert.equal(primaryBeforeResume.active, false, "a missing setup cookie does not silently grant setup authority");
  assert.equal(primaryBeforeResume.resumable, true, "the current primary-admin passkey session can discover unfinished setup");
  const primaryResume = await resumeSetupWithCookie(`troom_security_admin=${primaryAdminCookie}`);
  assert.equal(primaryResume.response.status, 200, JSON.stringify(primaryResume.body));
  assert.equal(primaryResume.body.active, true);
  assert.equal(primaryResume.body.credentialId, primaryCredentialId, "resume is pinned to the signed admin credential");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_credentials WHERE identity_id = 'primary-admin'"), 1,
    "resuming setup does not register another credential");
  assert.equal((await readSetupStatus(lostPrimarySetupToken)).active, false, "the old setup token is expired atomically");
  const primarySetupToken = primaryResume.setupToken;
  assert.ok(primarySetupToken);
  runSecuritySql(`UPDATE security_setup_sessions SET last_user_verification_at = ${Math.floor(Date.now() / 1000)}
    WHERE identity_id = 'primary-admin' AND credential_id = '${primaryCredentialId}' AND status = 'active'`);
  const primaryEnvelope = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${primarySetupToken}` },
    body: JSON.stringify({ serviceLinkId: "primary-admin-cloud-link", envelopeType: "admin_private_prf", encryptedPayload: "primary-encrypted", payloadIv: "primary-iv" })
  });
  assert.equal(primaryEnvelope.status, 200, `primary-admin resumed envelope: ${await primaryEnvelope.text()}`);
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_service_links WHERE id = 'primary-admin-cloud-link'"), "active");

  const primaryAdminHandoff = await createSecurityHandoff(primaryIdentityCookie, "cloud", "primary-admin-cloud-link");
  assert.equal(primaryAdminHandoff.response.status, 200, JSON.stringify(primaryAdminHandoff.body));
  assert.deepEqual(Object.keys(primaryAdminHandoff.body.tcloudKey || {}).sort(), ["admin_private_prf"],
    "administrator handoff contains only the credential-specific administrator envelope");
  const primarySubadminHandoff = await createSecurityHandoff(primaryIdentityCookie, "cloud", "primary-admin-cloud-subadmin-link");
  assert.equal(primarySubadminHandoff.response.status, 200, JSON.stringify(primarySubadminHandoff.body));
  assert.equal(primarySubadminHandoff.body.link.accountId, "subadmin");
  assert.equal(primarySubadminHandoff.body.link.role, "subadmin");
  assert.deepEqual(primarySubadminHandoff.body.tcloudKey, {},
    "subadministrator handoff exposes no administrator, recovery, PRF, client-vault, or folder-key envelope");

  const redeemedPrimaryAdmin = await redeemServiceHandoff("cloud", primaryAdminHandoff.body.handoffToken);
  const redeemedPrimarySubadmin = await redeemServiceHandoff("cloud", primarySubadminHandoff.body.handoffToken);
  assert.equal(redeemedPrimaryAdmin.response.status, 200, JSON.stringify(redeemedPrimaryAdmin.body));
  assert.equal(redeemedPrimarySubadmin.response.status, 200, JSON.stringify(redeemedPrimarySubadmin.body));
  const primaryAdminPayload = decodeSignedPayload(redeemedPrimaryAdmin.cookie);
  const primarySubadminPayload = decodeSignedPayload(redeemedPrimarySubadmin.cookie);
  assert.equal(primaryAdminPayload.role, "admin");
  assert.equal(primaryAdminPayload.serviceAccountId, "admin");
  assert.equal(primarySubadminPayload.role, "subadmin");
  assert.equal(primarySubadminPayload.serviceAccountId, "subadmin");
  assert.equal(primarySubadminPayload.serviceLinkId, "primary-admin-cloud-subadmin-link");
  assert.equal(primarySubadminPayload.rootFolderId, null);

  const passwordSubadmin = await loginCloudSubadmin();
  assert.equal(passwordSubadmin.response.status, 200, JSON.stringify(passwordSubadmin.body));
  for (const permission of ["canUpload", "canDelete", "canTrashUnlockedFiles", "canEditFiles", "canEditFolders", "canRenameUnlockedItems", "canViewHistory", "canRequestDelete", "canReviewDeletion"]) {
    assert.equal(redeemedPrimarySubadmin.body[permission], passwordSubadmin.body[permission],
      `passkey subadmin keeps the password subadmin ${permission} permission`);
  }
  assert.equal(redeemedPrimarySubadmin.body.role, "subadmin");
  const subadminCrypto = await cloudRequest(redeemedPrimarySubadmin.cookie, "/cloud/api/crypto-config");
  assert.equal(subadminCrypto.response.status, 200, JSON.stringify(subadminCrypto.body));
  for (const secretField of ["adminPrivateCipher", "adminPrivateIv", "recoveryPrivateCipher", "recoveryPrivateIv"]) {
    assert.equal(Object.hasOwn(subadminCrypto.body, secretField), false, `subadmin does not receive ${secretField}`);
  }
  const subadminUsage = await cloudRequest(redeemedPrimarySubadmin.cookie, "/cloud/api/usage");
  assert.equal(subadminUsage.response.status, 403, "passkey subadmin cannot use an administrator-only API");
  const subadminItems = await cloudRequest(redeemedPrimarySubadmin.cookie, "/cloud/api/items");
  assert.equal(subadminItems.response.status, 200, JSON.stringify(subadminItems.body));
  assert.ok(subadminItems.body.folders.some((folder) => Number(folder.id) === cloudSelectedRootId),
    "passkey subadmin keeps the existing whole-Cloud listing scope without administrator privileges");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE identity_id = 'primary-admin' AND service = 'cloud' AND event_type = 'passkey_login_success'
      AND service_link_id = 'primary-admin-cloud-subadmin-link' AND service_account_id = 'subadmin'
      AND role = 'subadmin' AND auth_method = 'passkey'`), 1,
  "Security audit records the selected subadmin account and role exactly");

  runSecuritySql("UPDATE security_service_links SET status = 'disabled' WHERE id = 'primary-admin-cloud-subadmin-link'");
  const revokedSubadminSession = await cloudRequest(redeemedPrimarySubadmin.cookie, "/cloud/api/items");
  assert.equal(revokedSubadminSession.response.status, 401, "disabling the subadmin link revokes its existing passkey session");
  const stillActiveAdminSession = await cloudRequest(redeemedPrimaryAdmin.cookie, "/cloud/api/items");
  assert.equal(stillActiveAdminSession.response.status, 200, "disabling subadmin does not revoke the separately selected admin link");
  const completedPrimaryResume = await resumeSetupWithCookie(`troom_security_admin=${primaryAdminCookie}`);
  assert.equal(completedPrimaryResume.response.status, 409, "completed primary-admin setup cannot be elevated again");

  const setupToken = "setup-session-token-for-retry-test-1234567890";
  const setupTokenHash = createHash("sha256").update(setupToken).digest("base64url");
  runSecuritySql(`INSERT INTO security_setup_sessions
    (id, token_hash, identity_id, credential_id, expires_at, last_user_verification_at)
    VALUES ('setup-retry', '${setupTokenHash}', '${identityId}', '${credentialId}', ${Math.floor(Date.now() / 1000) + 3600}, ${Math.floor(Date.now() / 1000)})`);
  const generalResumeState = await readSetupStatusWithCookies(`troom_security_identity=${oldIdentityCookie}`);
  assert.equal(generalResumeState.resumable, true, "an active general Identity credential can resume lost setup authority");
  const credentialCountBeforeResume = queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_credentials WHERE identity_id = '${identityId}'`);
  const generalResume = await resumeSetupWithCookie(`troom_security_identity=${oldIdentityCookie}`, { credentialId: readinessCredentialB });
  assert.equal(generalResume.response.status, 200, JSON.stringify(generalResume.body));
  assert.equal(generalResume.body.credentialId, credentialId, "the server pins resume to the signed Identity credential");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_credentials WHERE identity_id = '${identityId}'`), credentialCountBeforeResume,
    "general setup resume never creates another credential");
  assert.equal((await readSetupStatus(setupToken)).active, false, "the prior general setup token is no longer accepted");
  const resumedGeneralToken = generalResume.setupToken;
  assert.ok(resumedGeneralToken);
  runSecuritySql(`UPDATE security_setup_sessions SET last_user_verification_at = ${Math.floor(Date.now() / 1000)}
    WHERE identity_id = '${identityId}' AND credential_id = '${credentialId}' AND status = 'active'`);
  const setupPrfOptions = await readPrfOptions(resumedGeneralToken, credentialId);
  assert.equal(typeof setupPrfOptions.extensions?.prf?.evalByCredential?.[credentialId]?.first, "string",
    "setup PRF input crosses HTTP as Base64URL text");
  assert.equal(setupPrfOptions.extensions.prf.evalByCredential[credentialId].first, "dGVzdC1wcmYtc2FsdA",
    "setup retry preserves the same credential PRF salt bytes");
  const vaultBody = {
    serviceLinkId: "setup-cloud-member", envelopeType: "client_private_prf",
    publicKeyJwk: { kty: "RSA", alg: "RSA-OAEP-256", key_ops: ["encrypt"], ext: true, n: "AQIDBA", e: "AQAB" },
    encryptedPayload: "encrypted-private-key", payloadIv: "encrypted-private-key-iv"
  };
  const firstVaultSave = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${resumedGeneralToken}` },
    body: JSON.stringify(vaultBody)
  });
  assert.equal(firstVaultSave.status, 200, `initial client-vault save: ${await firstVaultSave.text()}`);
  const repeatedVaultSave = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${resumedGeneralToken}` },
    body: JSON.stringify(vaultBody)
  });
  assert.equal(repeatedVaultSave.status, 401, "a completed setup session cannot register an envelope again");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_tcloud_client_vaults WHERE credential_id = '${credentialId}'`), 1);
  const changedKey = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${resumedGeneralToken}` },
    body: JSON.stringify({ ...vaultBody, publicKeyJwk: { ...vaultBody.publicKeyJwk, n: "BQYHCA" } })
  });
  assert.equal(changedKey.status, 401, "completed setup authority cannot rotate the credential RSA key");
  const resumedSetup = await fetch("http://127.0.0.1:8810/security/api/setup/status", { headers: { Cookie: `troom_security_setup=${resumedGeneralToken}` } });
  assert.equal(resumedSetup.status, 200);
  const resumedSetupBody = await resumedSetup.json();
  assert.equal(resumedSetupBody.active, false);
  assert.equal(resumedSetupBody.completed, true);
  assert.equal(resumedSetupBody.tcloudReady, true, "a lost success response is recoverable as a read-only completed state");
  const repeatedGeneralResume = await resumeSetupWithCookie(`troom_security_identity=${oldIdentityCookie}`);
  assert.equal(repeatedGeneralResume.response.status, 409, "completed general setup cannot be elevated again");

  const guardSetupToken = "setup-guard-token-123456789012345678901234";
  const guardSetupHash = createHash("sha256").update(guardSetupToken).digest("base64url");
  runSecuritySql(`INSERT INTO security_setup_sessions
    (id, token_hash, identity_id, credential_id, expires_at)
    VALUES ('setup-guard', '${guardSetupHash}', '${identityId}', '${credentialId}', 1)`);
  assert.equal((await readSetupStatus(guardSetupToken)).active, false, "expired setup session is rejected");
  runSecuritySql(`UPDATE security_setup_sessions SET expires_at = ${Math.floor(Date.now() / 1000) + 3600} WHERE id = 'setup-guard'; UPDATE security_credentials SET status = 'revoked' WHERE credential_id = '${credentialId}'`);
  assert.equal((await readSetupStatus(guardSetupToken)).active, false, "revoked credential invalidates setup session");
  const revokedResume = await resumeSetupWithCookie(`troom_security_identity=${oldIdentityCookie}`);
  assert.equal(revokedResume.response.status, 401, "a revoked credential cannot regain setup authority");
  runSecuritySql(`UPDATE security_credentials SET status = 'active' WHERE credential_id = '${credentialId}'; UPDATE security_identities SET status = 'disabled' WHERE id = '${identityId}'`);
  assert.equal((await readSetupStatus(guardSetupToken)).active, false, "disabled Identity invalidates setup session");
  runSecuritySql(`UPDATE security_identities SET status = 'active' WHERE id = '${identityId}'; UPDATE security_setup_sessions SET status = 'completed' WHERE id = 'setup-guard'`);
  assert.equal((await readSetupStatus(guardSetupToken)).completed, true, "completed setup remains visible only as read-only completion state");

  const dashboardBefore = (await securityAdminRequest("/security/api/dashboard", oldAdminCookie)).body;
  const dashboardTimestamp = new Date().toISOString();
  runSecuritySql(`INSERT INTO security_audit_events
    (event_id, occurred_at, service, event_type, outcome, identity_id, auth_method)
    VALUES
    ('dashboard-security-login', '${dashboardTimestamp}', 'security', 'passkey_login_success', 'success', '${identityId}', 'passkey'),
    ('dashboard-diary-auth', '${dashboardTimestamp}', 'diary', 'passkey_authentication_success', 'success', '${identityId}', 'passkey'),
    ('dashboard-diary-login', '${dashboardTimestamp}', 'diary', 'passkey_login_success', 'success', '${identityId}', 'passkey'),
    ('dashboard-billing-password', '${dashboardTimestamp}', 'billing', 'password_login_success', 'success', '${identityId}', 'password'),
    ('dashboard-resume', '${dashboardTimestamp}', 'diary', 'session_resume', 'success', '${identityId}', 'passkey')`);
  const dashboardAfter = (await securityAdminRequest("/security/api/dashboard", oldAdminCookie)).body;
  assert.equal(dashboardAfter.loginSuccess - dashboardBefore.loginSuccess, 3,
    "dashboard counts only completed Security, service passkey, and password logins");
  assert.equal(dashboardAfter.sessionResume - dashboardBefore.sessionResume, 1,
    "dashboard reports resumed sessions separately");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_audit_events WHERE event_id = 'dashboard-diary-auth'"), 1,
    "the intermediate WebAuthn authentication event remains stored for audit inspection");

  runSecuritySql(`WITH RECURSIVE fixture(n) AS (
      SELECT 0 UNION ALL SELECT n + 1 FROM fixture WHERE n < 749
    )
    INSERT INTO security_audit_events
      (event_id, occurred_at, service, event_type, outcome, identity_id, auth_method, source_hash)
    SELECT printf('audit-page-%04d', n),
      strftime('%Y-%m-%dT%H:%M:%fZ', '2026-08-22T00:00:00Z', printf('-%d seconds', CAST(n / 5 AS INTEGER))),
      CASE n % 4 WHEN 0 THEN 'security' WHEN 1 THEN 'cloud' WHEN 2 THEN 'diary' ELSE 'billing' END,
      'audit_pagination_fixture',
      CASE n % 5 WHEN 0 THEN 'success' WHEN 1 THEN 'failure' WHEN 2 THEN 'blocked' WHEN 3 THEN 'cancelled' ELSE 'info' END,
      '${identityId}',
      CASE n % 3 WHEN 0 THEN 'password' WHEN 1 THEN 'passkey' ELSE 'system' END,
      'pagination-fixture'
    FROM fixture`);
  const pagedAudit = await fetchAllAudit(oldAdminCookie, { eventType: "audit_pagination_fixture" });
  assert.equal(pagedAudit.pages, 8, "750 audit events are delivered in bounded pages");
  assert.equal(pagedAudit.events.length, 750);
  assert.equal(new Set(pagedAudit.events.map((event) => event.event_id)).size, 750, "cursor pagination has no duplicates or gaps");
  for (let index = 1; index < pagedAudit.events.length; index += 1) {
    const previous = pagedAudit.events[index - 1];
    const current = pagedAudit.events[index];
    assert.ok(previous.occurred_at > current.occurred_at
      || (previous.occurred_at === current.occurred_at && previous.event_id < current.event_id),
    "same-timestamp events use event_id as a stable tie-breaker");
  }
  for (const filters of [
    { eventType: "audit_pagination_fixture", identityId },
    { eventType: "audit_pagination_fixture", service: "cloud" },
    { eventType: "audit_pagination_fixture", outcome: "failure" },
    { eventType: "audit_pagination_fixture", authMethod: "password" },
    { eventType: "audit_pagination_fixture", identityId, service: "diary", outcome: "blocked", authMethod: "system" },
    { eventType: "audit_pagination_fixture", from: "2026-08-22", to: "2026-08-22" }
  ]) {
    const filtered = await fetchAllAudit(oldAdminCookie, filters);
    const expected = pagedAudit.events.filter((event) => {
      if (filters.service && event.service !== filters.service) return false;
      if (filters.identityId && event.identity_id !== filters.identityId) return false;
      if (filters.outcome && event.outcome !== filters.outcome) return false;
      if (filters.authMethod && event.auth_method !== filters.authMethod) return false;
      if (filters.eventType && event.event_type !== filters.eventType) return false;
      if (filters.from && event.occurred_at < "2026-08-21T15:00:00.000Z") return false;
      if (filters.to && event.occurred_at >= "2026-08-22T15:00:00.000Z") return false;
      return true;
    });
    assert.equal(filtered.events.length, expected.length, `filtered pagination is complete for ${JSON.stringify(filters)}`);
    assert.equal(new Set(filtered.events.map((event) => event.event_id)).size, filtered.events.length,
      `filtered pagination has no duplicates for ${JSON.stringify(filters)}`);
  }
  const invalidCursor = await fetch("http://127.0.0.1:8810/security/api/audit?cursor=***", {
    headers: { Cookie: `troom_security_admin=${oldAdminCookie}` }
  });
  assert.equal(invalidCursor.status, 400, "malformed audit cursors fail closed");

  const passkeyCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 1);
  const passwordCookies = createServiceCookies("password", diaryVersion, billingVersion);
  await waitForServiceBindings(passkeyCookies);
  await assertAccess(passkeyCookies, true, "active passkey sessions");
  await assertSessionRefreshPolicies(passkeyCookies, passwordCookies);
  const expiredPasskeyCookies = Object.fromEntries(Object.entries(passkeyCookies).map(([name, cookie]) => {
    const payload = decodeSignedPayload(cookie);
    return [name, signCookie({ ...payload, exp: Math.floor(Date.now() / 1000) - 1 })];
  }));
  await assertAccess(expiredPasskeyCookies, false, "expired passkey sessions cannot be resumed or rolled");

  const handoffDiaryCookie = await redeemDiaryAdminHandoff();
  const handoffPayload = decodeSignedPayload(handoffDiaryCookie);
  assert.equal(handoffPayload.passkeySessionEpoch, 1, "Diary handoff session starts with the Security epoch");
  const handoffAccess = await fetch(`http://127.0.0.1:${services.diary.port}${services.diary.path}`, {
    headers: { Cookie: `${services.diary.cookie}=${handoffDiaryCookie}` }
  });
  assert.equal(handoffAccess.status, 200, "valid Diary handoff cookie can access the protected API");
  const switchedDiary = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/households/select`, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${services.diary.port}`,
      "Content-Type": "application/json",
      "X-Diary-Request": "1",
      Cookie: `${services.diary.cookie}=${handoffDiaryCookie}`
    },
    body: JSON.stringify({ householdId: "chiharu-household" })
  });
  assert.equal(switchedDiary.status, 200, `Diary household switch: ${await switchedDiary.text()}`);
  const switchedDiaryCookie = switchedDiary.headers.get("set-cookie")?.match(/troom_diary_session=([^;]+)/)?.[1];
  assert.ok(switchedDiaryCookie, "Diary household switch reissues its session cookie");
  const switchedPayload = decodeSignedPayload(switchedDiaryCookie);
  for (const key of ["identityId", "credentialId", "serviceLinkId", "serviceAccountId", "passkeySessionEpoch", "authMethod"]) {
    assert.equal(switchedPayload[key], handoffPayload[key], `Diary household switch preserves ${key}`);
  }
  assert.equal(switchedPayload.activeHouseholdId, "chiharu-household");
  assert.equal(switchedPayload.exp, handoffPayload.exp, "Diary household switch preserves the passkey absolute expiry");
  assert.doesNotMatch(switchedDiary.headers.get("set-cookie") || "", /Max-Age|Expires=/i,
    "Diary household switch keeps a non-persistent passkey cookie");
  const switchedAccess = await fetch(`http://127.0.0.1:${services.diary.port}${services.diary.path}`, {
    headers: { Cookie: `${services.diary.cookie}=${switchedDiaryCookie}` }
  });
  assert.equal(switchedAccess.status, 200, "the switched Diary passkey cookie remains valid on the next API request");

  runSecuritySql(`UPDATE security_credentials SET status = 'revoked' WHERE credential_id = '${credentialId}'`);
  await assertAccess(passkeyCookies, false, "credential revoke");
  await assertSingleAccess("diary", switchedDiaryCookie, false, "credential revoke rejects the household-switched Diary cookie");
  await assertAccess(passwordCookies, true, "password sessions after credential revoke");

  runSecuritySql(`UPDATE security_credentials SET status = 'active', revoked_at = NULL WHERE credential_id = '${credentialId}'`);
  await assertSingleAccess("diary", switchedDiaryCookie, true, "the fixture can continue to the epoch and local-switch checks after credential restoration");
  const replacementLinks = {};
  for (const [name, service] of Object.entries(services)) {
    runSecuritySql(`UPDATE security_service_links SET status = 'disabled' WHERE id = '${service.linkId}'`);
    await assertSingleAccess(name, passkeyCookies[name], false, `${name} service-link removal`);
    for (const otherName of Object.keys(services).filter((candidate) => candidate !== name)) {
      const otherCookie = replacementLinks[otherName]
        ? createServiceCookies("passkey", diaryVersion, billingVersion, 1, replacementLinks)[otherName]
        : passkeyCookies[otherName];
      await assertSingleAccess(otherName, otherCookie, true, `${name} removal must not revoke ${otherName}`);
    }
    const replacementId = `${service.linkId}-replacement`;
    replacementLinks[name] = replacementId;
    runSecuritySql(`INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES ('${replacementId}', '${identityId}', '${name}', '${service.accountId}', '${name} replacement', 'active')`);
    await assertSingleAccess(name, passkeyCookies[name], false, `${name} old cookie must stay revoked after identical link is re-added`);
  }

  const replacementCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 1, replacementLinks);
  await assertAccess(replacementCookies, true, "newly authenticated cookies use fresh service-link IDs");

  for (const disabledService of Object.keys(services)) {
    stopServiceWorkers();
    await delay(300);
    await startServiceWorkers(Object.fromEntries(Object.keys(services).map((name) => [name, name !== disabledService])));
    await assertSingleAccess(disabledService, replacementCookies[disabledService], false, `${disabledService} local kill switch`);
    if (disabledService === "diary") {
      await assertSingleAccess("diary", switchedDiaryCookie, false, "Diary local kill switch rejects the household-switched passkey cookie");
    }
    for (const activeService of Object.keys(services).filter((name) => name !== disabledService)) {
      await assertSingleAccess(activeService, replacementCookies[activeService], true, `${disabledService} local kill switch must not affect ${activeService}`);
    }
    await assertAccess(passwordCookies, true, `password sessions while only ${disabledService} passkeys are disabled`);
    assert.equal(queryNumber("security-worker", "security-db", "SELECT passkey_session_epoch AS value FROM security_runtime_state WHERE id = 1"), 1,
      "service-local kill switches must not change the global epoch");
  }

  stopServiceWorkers();
  await delay(300);
  await startServiceWorkers(true);

  // Start the global transition while the currently deployed Worker still has
  // PASSKEY_ENABLED=true. The persistent gate must close atomically with the
  // epoch change, so this former race window cannot issue a new session.
  disableGlobalRuntime();
  assert.equal(queryNumber("security-worker", "security-db", "SELECT passkey_session_epoch AS value FROM security_runtime_state WHERE id = 1"), 2);
  const transitionChallenges = queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_challenges");
  const transitionAuthentication = await fetch("http://127.0.0.1:8810/security/api/auth/options", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json" },
    body: JSON.stringify({ service: "security" })
  });
  assert.equal(transitionAuthentication.status, 503, "disable transition stops authentication before the false Secret is deployed");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT COUNT(*) AS value FROM security_challenges"), transitionChallenges,
    "the transition does not create a WebAuthn challenge");
  assert.equal(await securityAdminAuthenticated(oldAdminCookie), false, "disable transition immediately rejects the old Security admin cookie");
  assert.equal(await securityIdentityHandoff(oldIdentityCookie), 503, "disable transition cannot issue a handoff while the Secret is still true");
  await assertAccess(replacementCookies, false, "disable transition rejects every service passkey cookie before the false Secret is deployed");
  await assertSingleAccess("diary", switchedDiaryCookie, false, "global epoch transition rejects the household-switched Diary cookie");
  await assertAccess(passwordCookies, true, "password sessions remain valid while the global runtime gate is closed");

  stopSecurityWorker();
  await delay(300);
  const zeroAccessDisabledWorker = startSecurityWorker(false);
  await waitForWorkerReady(zeroAccessDisabledWorker);
  assert.equal(queryNumber("security-worker", "security-db", "SELECT passkey_session_epoch AS value FROM security_runtime_state WHERE id = 1"), 2);
  // Intentionally make zero HTTP/API requests while the Security global switch is off.
  stopSecurityWorker();
  await delay(300);
  const zeroAccessEnabledWorker = startSecurityWorker(true);
  await waitForWorkerReady(zeroAccessEnabledWorker);
  enableGlobalRuntime();
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  assert.equal(await securityAdminAuthenticated(oldAdminCookie), false, "zero-access disable revokes the old Security admin cookie after re-enable");
  assert.equal(await securityIdentityHandoff(oldIdentityCookie), 401, "zero-access disable revokes the old Security identity cookie after re-enable");
  await assertAccess(replacementCookies, false, "zero-access disable revokes every old service passkey cookie after re-enable");
  const newEpochCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 2, replacementLinks);
  await assertAccess(newEpochCookies, true, "new passkey login after zero-access kill switch uses the new epoch");
  const newAdminCookie = signSecurityCookie({ kind: "admin", identityId: "audit_admin", credentialId: "audit-credential", passkeySessionEpoch: 2 });
  const newIdentityCookie = signSecurityCookie({ kind: "identity", identityId, credentialId, passkeySessionEpoch: 2 });
  assert.equal(await securityAdminAuthenticated(newAdminCookie), true, "new Security admin cookie uses the new epoch");
  assert.equal(await securityIdentityHandoff(newIdentityCookie, replacementLinks.diary), 200, "new Security identity cookie uses the new epoch");

  disableGlobalRuntime();
  stopSecurityWorker();
  await delay(300);
  startSecurityWorker(false);
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  assert.equal(await securityAdminAuthenticated(newAdminCookie), false, "Security global kill switch rejects its admin cookie");
  await assertAccess(newEpochCookies, false, "Security global kill switch rejects every service passkey session");
  await assertAccess(passwordCookies, true, "password sessions remain valid during the Security global kill switch");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT passkey_session_epoch AS value FROM security_runtime_state WHERE id = 1"), 3);
  await assertAccess(newEpochCookies, false, "repeated OFF access does not restore or repeatedly advance sessions");
  assert.equal(queryNumber("security-worker", "security-db", "SELECT passkey_session_epoch AS value FROM security_runtime_state WHERE id = 1"), 3);

  stopSecurityWorker();
  await delay(300);
  const repeatedAccessEnabledWorker = startSecurityWorker(true);
  await waitForWorkerReady(repeatedAccessEnabledWorker);
  enableGlobalRuntime();
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  assert.equal(await securityAdminAuthenticated(newAdminCookie), false, "old Security admin cookie stays revoked after re-enable");
  assert.equal(await securityIdentityHandoff(newIdentityCookie), 401, "old Security identity cookie stays revoked after re-enable");
  await assertAccess(newEpochCookies, false, "old service passkey cookies stay revoked after global re-enable");
  const latestEpochCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 3, replacementLinks);
  await assertAccess(latestEpochCookies, true, "new passkey login after repeated-access kill switch uses the new epoch");
  await assertAccess(passwordCookies, true, "password sessions remain valid across the kill-switch cycle");

  const latestFreshAdminCookie = signSecurityCookie({
    kind: "admin", identityId: "audit_admin", credentialId: "audit-credential",
    passkeySessionEpoch: 3, authenticatedAt: Math.floor(Date.now() / 1000)
  });
  const removedOldDiary = await securityAdminRequest(`/security/api/service-links/${replacementLinks.diary}`, latestFreshAdminCookie, {});
  assert.equal(removedOldDiary.response.status, 200, JSON.stringify(removedOldDiary.body));
  console.log("service passkey revocation HTTP integration: ok");
} finally {
  for (const child of processes.splice(0).reverse()) stopProcess(child);
  cleanupSecurityFixture();
  if (cloudSelectedRootId && cloudChildId && cloudGrandchildId && cloudProtectedChildId
    && cloudProtectedGrandchildId && cloudUnselectedRootId) {
    runWrangler("cloud-worker", ["d1", "execute", "cloud-db", "--local", "--command",
      `DELETE FROM cloud_files WHERE object_key LIKE 'fixtures/${cloudFixtureTag}/%';
       DELETE FROM cloud_folders WHERE id = ${cloudProtectedGrandchildId};
       DELETE FROM cloud_folders WHERE id = ${cloudProtectedChildId};
       DELETE FROM cloud_folders WHERE id = ${cloudGrandchildId};
       DELETE FROM cloud_folders WHERE id = ${cloudChildId};
       DELETE FROM cloud_folders WHERE id = ${cloudUnselectedRootId};
       DELETE FROM cloud_folders WHERE id = ${cloudSelectedRootId}`]);
  }
}

function fixturePasswordHash(password) {
  const salt = Buffer.from("folder-member-fixture-salt");
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
  return `pbkdf2-sha256$100000$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function sha256PasswordHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

async function startServiceWorkers(passkeysEnabled) {
  const enabledByService = typeof passkeysEnabled === "object"
    ? passkeysEnabled
    : Object.fromEntries(Object.keys(services).map((name) => [name, Boolean(passkeysEnabled)]));
  processes.push(startWorker("cloud-worker", services.cloud.port, [
    `SESSION_SECRET:${sessionSecret}`, "ADMIN_LOGIN_ID:admin@example.test", "SUBADMIN_LOGIN_ID:subadmin@example.test",
    `ADMIN_AUTH_PROOF_HASH:${fixturePasswordHash(cloudAdminAuthProof)}`,
    `SUBADMIN_AUTH_PROOF_HASH:${fixturePasswordHash(cloudSubadminAuthProof)}`,
    "ACCOUNT_KDF_ID:integration-account",
    `PASSKEY_ENABLED:${String(enabledByService.cloud)}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("diary-worker", services.diary.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${String(enabledByService.diary)}`, "ALLOW_LOCAL_HTTP:true",
    "DIARY_MAIN_ADMIN_LOGIN_ID:main-admin@example.test", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
    `DIARY_MAIN_ADMIN_PASSWORD_HASH:${sha256PasswordHash(diaryAdminPassword)}`,
    `DIARY_WIFE_ADMIN_PASSWORD_HASH:${sha256PasswordHash(diaryWifePassword)}`
  ]));
  processes.push(startWorker("billing-worker", services.billing.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${String(enabledByService.billing)}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("ai-worker", 8814, [
    `SESSION_SECRET:${sessionSecret}`, "AI_SAFETY_SALT:ai-integration-safety-salt", "AI_PROVIDER_MODE:mock"
  ]));
  processes.push(startWorker("security-worker", 8815, [], [
    "--config", "test/downloader-service-fixture.wrangler.jsonc"
  ], "downloader-fixture"));
  await Promise.all(Object.entries(services).map(([name, service]) =>
    waitForUrl(`http://127.0.0.1:${service.port}${sessionPath(name)}`)));
  await waitForUrl("http://127.0.0.1:8814/ai/api/session");
  await waitForUrl("http://127.0.0.1:8815/");
}

function startSecurityWorker(passkeysEnabled) {
  const child = startWorker("security-worker", 8810, [
    `SESSION_SECRET:${securitySessionSecret}`, "AUDIT_IP_SALT:security-integration-salt",
    `PASSKEY_ENABLED:${String(passkeysEnabled)}`, "ALLOW_LOCAL_HTTP:true", "EXPECTED_ORIGIN:http://127.0.0.1:8810"
  ]);
  processes.push(child);
  return child;
}

function stopSecurityWorker() {
  const index = processes.findIndex((child) => child.__directory === "security-worker");
  if (index < 0) return;
  stopProcess(processes[index]);
  processes.splice(index, 1);
}

function stopServiceWorkers() {
  for (let index = processes.length - 1; index >= 0; index -= 1) {
    const child = processes[index];
    if (child.__directory === "security-worker") continue;
    stopProcess(child);
    processes.splice(index, 1);
  }
}

async function waitForServiceBindings(cookies) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await assertAccess(cookies, true, "service binding readiness");
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError || new Error("Security service bindings did not connect.");
}

async function assertAccess(cookies, expected, label) {
  for (const name of Object.keys(services)) await assertSingleAccess(name, cookies[name], expected, label);
}

async function securityAdminAuthenticated(cookie) {
  const response = await fetch("http://127.0.0.1:8810/security/api/status", {
    headers: { Cookie: `troom_security_admin=${cookie}` }
  });
  assert.equal(response.status, 200);
  return Boolean((await response.json()).adminAuthenticated);
}

async function securityIdentityHandoff(cookie, linkId = services.diary.linkId) {
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/handoff", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_identity=${cookie}`
    },
    body: JSON.stringify({ service: "diary", linkId })
  });
  return response.status;
}

async function createSecurityHandoff(cookie, service, linkId) {
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/handoff", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_identity=${cookie}`
    },
    body: JSON.stringify({ service, linkId })
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function redeemServiceHandoff(name, handoffToken) {
  const service = services[name];
  const response = await fetch(`http://127.0.0.1:${service.port}/${name}/api/passkey/handoff`, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${service.port}`,
      "Content-Type": "application/json",
      ...(name === "diary" ? { "X-Diary-Request": "1" } : {})
    },
    body: JSON.stringify({ handoffToken })
  });
  const body = await response.json().catch(() => ({}));
  const cookie = response.headers.get("set-cookie")?.match(new RegExp(`${service.cookie}=([^;]+)`))?.[1] || null;
  return { response, body, cookie };
}

async function loginDiary(loginId, password) {
  const response = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/login`, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${services.diary.port}`,
      "Content-Type": "application/json",
      "X-Diary-Request": "1"
    },
    body: JSON.stringify({ loginId, password })
  });
  const body = await response.json().catch(() => ({}));
  const cookie = response.headers.get("set-cookie")?.match(/troom_diary_session=([^;]+)/)?.[1] || null;
  return { response, body, cookie };
}

async function loginCloudSubadmin() {
  const response = await fetch(`http://127.0.0.1:${services.cloud.port}/cloud/api/login`, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${services.cloud.port}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      loginId: "subadmin@example.test",
      authProof: cloudSubadminAuthProof
    })
  });
  const body = await response.json().catch(() => ({}));
  const cookie = response.headers.get("set-cookie")?.match(/troom_cloud_session=([^;]+)/)?.[1] || null;
  return { response, body, cookie };
}

async function assertCloudFolderAccess(cookie, folderId, expectedStatus, label) {
  const response = await fetch(`http://127.0.0.1:${services.cloud.port}/cloud/api/items?folderId=${folderId}`, {
    headers: { Cookie: `${services.cloud.cookie}=${cookie}` }
  });
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `${label}: ${body.slice(0, 300)}`);
}

async function assertFolderMemberApiScope(cookie) {
  const payload = decodeSignedPayload(cookie);
  assert.equal(payload.role, "member");
  assert.equal(payload.rootFolderId, cloudSelectedRootId);
  assert.equal(payload.serviceAccountId, "folder-member");
  assert.equal(queryNumber("cloud-worker", "cloud-db",
    `SELECT COUNT(*) AS value FROM cloud_folder_unlocks WHERE session_id = '${payload.sessionId}' AND folder_id = ${cloudSelectedRootId}`), 0,
  "the delegated root is usable without creating a legacy folder-password unlock");

  const top = await cloudRequest(cookie, "/cloud/api/items");
  assert.equal(top.response.status, 200, JSON.stringify(top.body));
  assert.deepEqual(top.body.folders.map((folder) => Number(folder.id)), [cloudSelectedRootId],
    "the T-Cloud top shows only the assigned root folder");
  assert.equal(top.body.folders[0].isUnlocked, true, "the assigned root is represented as passkey-unlocked");

  const root = await cloudRequest(cookie, `/cloud/api/items?folderId=${cloudSelectedRootId}`);
  assert.equal(root.response.status, 200, JSON.stringify(root.body));
  assert.equal(root.body.breadcrumbs.length, 1, "member breadcrumbs stop at the assigned root");
  assert.equal(root.body.breadcrumbs[0].isUnlocked, true,
    "the linked root stays unlocked even though its legacy password hash is retained");
  assert.ok(root.body.files.some((file) => Number(file.id) === cloudRootFileId));
  assert.ok(root.body.folders.some((folder) => Number(folder.id) === cloudProtectedChildId && !folder.isUnlocked),
    "a separately protected child remains visibly locked");

  const rootSearch = await cloudRequest(cookie,
    `/cloud/api/items?q=${encodeURIComponent("本人検索")}&recursive=1`);
  assert.equal(rootSearch.response.status, 200, `${JSON.stringify(rootSearch.body)}\n${workerOutput("cloud-worker")}`);
  assert.ok(rootSearch.body.files.some((file) => Number(file.id) === cloudRootFileId),
    "recursive search uses the passkey-unlocked root as its anchor");
  const outsideSearch = await cloudRequest(cookie,
    `/cloud/api/items?q=${encodeURIComponent("他人検索")}&recursive=1`);
  assert.equal(outsideSearch.response.status, 200, JSON.stringify(outsideSearch.body));
  assert.equal(outsideSearch.body.files.some((file) => Number(file.id) === cloudUnselectedFileId), false,
    "recursive search cannot reveal files outside the linked root");
  assert.equal(outsideSearch.body.folders.some((folder) => Number(folder.id) === cloudUnselectedRootId), false,
    "recursive search cannot reveal folder names outside the linked root");

  const ownFile = await cloudRequest(cookie, `/cloud/api/files/${cloudRootFileId}`);
  assert.equal(ownFile.response.status, 200, JSON.stringify(ownFile.body));
  for (const suffix of ["", "/thumbnail", "/display-thumbnail", "/view", "/download"]) {
    const outside = await cloudRequest(cookie, `/cloud/api/files/${cloudUnselectedFileId}${suffix}`);
    assert.equal(outside.response.status, 403, `outside direct file API ${suffix || "metadata"}: ${JSON.stringify(outside.body)}`);
  }
  const outsideRename = await cloudRequest(cookie, `/cloud/api/files/${cloudUnselectedFileId}`, {
    method: "PATCH", body: { name: "unauthorized.txt" }
  });
  assert.equal(outsideRename.response.status, 403, JSON.stringify(outsideRename.body));
  const outsideMove = await cloudRequest(cookie, `/cloud/api/files/${cloudRootFileId}`, {
    method: "PATCH", body: { name: cloudRootFileName, folderId: cloudUnselectedRootId }
  });
  assert.equal(outsideMove.response.status, 403, JSON.stringify(outsideMove.body));
  const outsideTrash = await cloudRequest(cookie, `/cloud/api/files/${cloudUnselectedFileId}`, { method: "DELETE" });
  assert.equal(outsideTrash.response.status, 403, JSON.stringify(outsideTrash.body));
  const outsideDownloadEvent = await cloudRequest(cookie, "/cloud/api/download-events", {
    method: "POST", body: { fileId: cloudUnselectedFileId, eventType: "download_started" }
  });
  assert.equal(outsideDownloadEvent.response.status, 403, JSON.stringify(outsideDownloadEvent.body));
  const outsideUpload = await cloudRequest(cookie, "/cloud/api/uploads", {
    method: "POST",
    body: {
      folderId: cloudUnselectedRootId, sizeBytes: 1, cryptoVersion: 1,
      encryptedMetadata: "AA", metadataIv: "AA", wrappedFileKey: "AA", fileKeyIv: "AA",
      encryptedSizeBytes: 33, chunkSizeBytes: 8 * 1024 * 1024, chunkCount: 1
    }
  });
  assert.equal(outsideUpload.response.status, 403, JSON.stringify(outsideUpload.body));
  const outsidePlayer = await cloudRequest(cookie, `/cloud/api/player/media?rootFolderId=${cloudUnselectedRootId}`);
  assert.equal(outsidePlayer.response.status, 403, JSON.stringify(outsidePlayer.body));

  const destinations = await cloudRequest(cookie, `/cloud/api/move-destinations?rootFolderId=${cloudSelectedRootId}`);
  assert.equal(destinations.response.status, 200, JSON.stringify(destinations.body));
  assert.equal(destinations.body.folders.some((folder) => Number(folder.id) === cloudUnselectedRootId), false,
    "move destinations stay inside the selected root");
  const player = await cloudRequest(cookie, `/cloud/api/player/media?rootFolderId=${cloudSelectedRootId}`);
  assert.equal(player.response.status, 200, JSON.stringify(player.body));
  assert.ok(player.body.files.some((file) => Number(file.id) === cloudRootFileId));
  assert.equal(player.body.files.some((file) => Number(file.id) === cloudProtectedFileId), false,
    "Player does not cross an independently protected child boundary");
  assert.equal(player.body.files.some((file) => Number(file.id) === cloudUnselectedFileId), false,
    "Player never returns another root's media");

  await assertCloudFolderAccess(cookie, cloudProtectedChildId, 423,
    "an independently protected child requires its own password");
  await assertCloudFolderAccess(cookie, cloudProtectedGrandchildId, 423,
    "a locked protected child also blocks direct descendant IDs");
  const protectedFileBeforeUnlock = await cloudRequest(cookie, `/cloud/api/files/${cloudProtectedFileId}`);
  assert.equal(protectedFileBeforeUnlock.response.status, 423, JSON.stringify(protectedFileBeforeUnlock.body));
  const wrongUnlock = await cloudRequest(cookie, `/cloud/api/folders/${cloudProtectedChildId}/unlock`, {
    method: "POST", body: { password: `${cloudProtectedPassword}-wrong` }
  });
  assert.equal(wrongUnlock.response.status, 401, JSON.stringify(wrongUnlock.body));
  const correctUnlock = await cloudRequest(cookie, `/cloud/api/folders/${cloudProtectedChildId}/unlock`, {
    method: "POST", body: { password: cloudProtectedPassword }
  });
  assert.equal(correctUnlock.response.status, 200, JSON.stringify(correctUnlock.body));
  await assertCloudFolderAccess(cookie, cloudProtectedGrandchildId, 200,
    "the protected child and its descendants work after the existing password flow succeeds");
  const protectedFileAfterUnlock = await cloudRequest(cookie, `/cloud/api/files/${cloudProtectedFileId}`);
  assert.equal(protectedFileAfterUnlock.response.status, 200, JSON.stringify(protectedFileAfterUnlock.body));
}

async function cloudRequest(cookie, path, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${services.cloud.port}${path}`, {
    method,
    headers: {
      Cookie: `${services.cloud.cookie}=${cookie}`,
      ...(method === "GET" ? {} : { Origin: `http://127.0.0.1:${services.cloud.port}`, "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 500) await delay(250);
  return { response, body: payload };
}

function workerOutput(directory) {
  return processes.find((child) => child.__directory === directory)?.__output?.slice(-4000) || "";
}

function assertPlainPublicLink(link, expected) {
  assert.ok(link && typeof link === "object" && !Array.isArray(link), `${expected.service} handoff contains a plain link object`);
  assert.equal(link.id, expected.linkId);
  assert.equal(link.service, expected.service);
  assert.equal(link.accountId, expected.accountId);
  assert.equal(link.role, expected.role);
  assert.ok(typeof link.displayLabel === "string" && link.displayLabel.length > 0,
    `${expected.service} handoff contains a human display label`);
  assert.ok(typeof link.roleLabel === "string" && link.roleLabel.length > 0,
    `${expected.service} handoff contains a human role label`);
  assert.equal(Object.hasOwn(link, "rootFolderId"), true);
  assert.equal(Object.hasOwn(link, "scopeLabel"), true);
}

function containsThenable(value, seen = new Set()) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  if (typeof value.then === "function") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => containsThenable(item, seen));
}

function assertNoPlaintextSecrets(value) {
  const forbidden = /^(?:password|authProof|session|cookie|prfOutput|privateKey|folderKey|fileKey|secret)$/i;
  const inspect = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(forbidden.test(key), false, `handoff link must not expose ${key}`);
      inspect(nested);
    }
  };
  inspect(value);
}

async function securityAdminRequest(path, cookie, body) {
  const response = await fetch(`http://127.0.0.1:8810${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json" }),
      Cookie: `troom_security_admin=${cookie}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function securityCloudHandoff(cookie) {
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/handoff", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_identity=${cookie}`
    },
    body: JSON.stringify({ service: "cloud", linkId: "readiness-cloud-link" })
  });
  return response.status;
}

async function cloudAuthenticationCredentialIds() {
  const options = await readAuthenticationOptions("cloud");
  return options.allowCredentials.map((item) => item.id);
}

async function readAuthenticationOptions(service) {
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/options", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json" },
    body: JSON.stringify({ service })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.options;
}

async function readPrfOptions(setupToken, requestedCredentialId) {
  const response = await fetch("http://127.0.0.1:8810/security/api/prf/options", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_setup=${setupToken}`
    },
    body: JSON.stringify({ credentialId: requestedCredentialId })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.options;
}

async function securityIdentityDetail(identity, cookie) {
  const response = await fetch(`http://127.0.0.1:8810/security/api/identities/${identity}`, {
    headers: { Cookie: `troom_security_admin=${cookie}` }
  });
  const body = await response.json();
  if (response.status !== 200) await delay(300);
  const workerOutput = processes.find((child) => child.__directory === "security-worker")?.__output || "";
  assert.equal(response.status, 200, `${JSON.stringify(body)}\n${workerOutput.slice(-3000)}`);
  return body;
}

async function approveCredentialCloudLink(identity, credential, cookie, wrappedKey = "wrapped-b") {
  const response = await fetch(`http://127.0.0.1:8810/security/api/identities/${identity}/approve`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_admin=${cookie}`
    },
    body: JSON.stringify({ credentialId: credential, cloudEnvelopes: [{ serviceLinkId: "readiness-cloud-link", wrappedKey }] })
  });
  const body = await response.json();
  if (response.status !== 200) await delay(300);
  const workerOutput = processes.find((child) => child.__directory === "security-worker")?.__output || "";
  assert.equal(response.status, 200, `${JSON.stringify(body)}\n${workerOutput.slice(-3000)}`);
  return body;
}

async function readSetupStatus(token) {
  const response = await fetch("http://127.0.0.1:8810/security/api/setup/status", {
    headers: { Cookie: `troom_security_setup=${token}` }
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function readSetupStatusWithCookies(cookie) {
  const response = await fetch("http://127.0.0.1:8810/security/api/setup/status", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function resumeSetupWithCookie(cookie, body = {}) {
  const response = await fetch("http://127.0.0.1:8810/security/api/setup/resume", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  const setupToken = response.headers.get("set-cookie")?.match(/troom_security_setup=([^;]+)/)?.[1] || null;
  return { response, body: payload, setupToken };
}

async function fetchAllAudit(adminCookie, filters) {
  const events = [];
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams(filters);
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`http://127.0.0.1:8810/security/api/audit?${params}`, {
      headers: { Cookie: `troom_security_admin=${adminCookie}` }
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    events.push(...body.events);
    cursor = body.nextCursor || null;
    pages += 1;
    assert.ok(pages < 20, "audit cursor must terminate");
  } while (cursor);
  return { events, pages };
}

async function redeemDiaryAdminHandoff() {
  const rawToken = `diary-handoff-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("base64url");
  runSecuritySql(`INSERT INTO security_handoffs
    (id, token_hash, identity_id, service_link_id, credential_id, session_epoch, expires_at)
    VALUES ('${randomUUID()}', '${tokenHash}', '${identityId}', '${diaryAdminLinkId}', '${credentialId}', 1, ${Math.floor(Date.now() / 1000) + 60})`);
  const response = await fetch(`http://127.0.0.1:${services.diary.port}/diary/api/passkey/handoff`, {
    method: "POST",
    headers: { Origin: `http://127.0.0.1:${services.diary.port}`, "Content-Type": "application/json", "X-Diary-Request": "1" },
    body: JSON.stringify({ handoffToken: rawToken })
  });
  const body = await response.text();
  assert.equal(response.status, 200, `valid Diary handoff redeem: ${body}`);
  const setCookie = response.headers.get("set-cookie") || "";
  assert.doesNotMatch(setCookie, /Max-Age|Expires=/i, "Diary passkey handoff does not issue a persistent cookie");
  const cookie = setCookie.match(/troom_diary_session=([^;]+)/)?.[1];
  assert.ok(cookie, "Diary handoff issues a session cookie");
  const lifetime = decodeSignedPayload(cookie).exp - Math.floor(Date.now() / 1000);
  assert.ok(lifetime > 43190 && lifetime <= 43200, `Diary passkey session lifetime is twelve hours: ${lifetime}`);
  return cookie;
}

function decodeSignedPayload(cookie) {
  return JSON.parse(Buffer.from(String(cookie).split(".")[0], "base64url").toString("utf8"));
}

async function assertSessionRefreshPolicies(passkeyCookies, passwordCookies) {
  for (const [name, service] of Object.entries(services)) {
    const passkeyPayload = decodeSignedPayload(passkeyCookies[name]);
    const passkeyResponse = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
      headers: { Cookie: `${service.cookie}=${passkeyCookies[name]}` }
    });
    assert.equal(passkeyResponse.status, 200, `${name} passkey session remains usable inside its absolute TTL`);
    assert.equal(passkeyResponse.headers.get("set-cookie"), null, `${name} does not roll or reissue a passkey session`);
    assert.equal(decodeSignedPayload(passkeyCookies[name]).exp, passkeyPayload.exp);

    const passwordPayload = decodeSignedPayload(passwordCookies[name]);
    const passwordResponse = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
      headers: { Cookie: `${service.cookie}=${passwordCookies[name]}` }
    });
    assert.equal(passwordResponse.status, 200, `${name} password session remains usable`);
    const refreshedHeader = passwordResponse.headers.get("set-cookie") || "";
    assert.match(refreshedHeader, /Max-Age=2592000/, `${name} keeps the 30-day password cookie`);
    const refreshed = refreshedHeader.match(new RegExp(`${service.cookie}=([^;]+)`))?.[1];
    assert.ok(refreshed, `${name} rolls the password session`);
    assert.ok(decodeSignedPayload(refreshed).exp > passwordPayload.exp, `${name} extends only the password expiry`);
  }
}

async function assertSingleAccess(name, cookie, expected, label) {
  const service = services[name];
  const response = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
    headers: { Cookie: `${service.cookie}=${cookie}` }
  });
  const body = await response.text();
  assert.equal(response.status, expected ? 200 : 401, `${label}: ${name} returned ${response.status}: ${body.slice(0, 300)}`);
}

function createServiceCookies(authMethod, diaryVersion, billingVersion, passkeySessionEpoch = null, linkOverrides = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const auth = authMethod === "passkey" ? { identityId, credentialId, authMethod, passkeySessionEpoch } : { authMethod };
  return {
    cloud: signCookie({
      role: "admin", sessionId: randomUUID(), exp, version: services.cloud.version,
      ...auth, serviceLinkId: authMethod === "passkey" ? (linkOverrides.cloud || services.cloud.linkId) : null,
      serviceAccountId: authMethod === "passkey" ? services.cloud.accountId : null, rootFolderId: null
    }),
    diary: signCookie({
      role: "user", accountId: services.diary.accountId, activeHouseholdId: "tanaka-household",
      accountVersion: diaryVersion, exp, version: services.diary.version,
      ...auth, serviceLinkId: authMethod === "passkey" ? (linkOverrides.diary || services.diary.linkId) : null,
      serviceAccountId: authMethod === "passkey" ? services.diary.accountId : null
    }),
    billing: signCookie({
      role: "owner", accountId: services.billing.accountId, accountVersion: billingVersion,
      globalVersion: services.billing.version, exp,
      ...auth, serviceLinkId: authMethod === "passkey" ? (linkOverrides.billing || services.billing.linkId) : null,
      serviceAccountId: authMethod === "passkey" ? services.billing.accountId : null
    })
  };
}

function signCookie(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function signSecurityCookie(payload) {
  const encoded = Buffer.from(JSON.stringify({ authMethod: "passkey", ...payload, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const signature = createHmac("sha256", securitySessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function startWorker(directory, port, vars, extraArgs = [], marker = directory) {
  const child = spawn(process.execPath, [wranglerPath(directory), "dev", "--local", "--port", String(port),
    "--compatibility-date", "2026-08-06",
    ...extraArgs,
    ...vars.flatMap((value) => ["--var", value])], {
    cwd: `${repository}${directory}`, stdio: ["ignore", "pipe", "pipe"]
  });
  child.__directory = marker;
  child.__output = "";
  child.stdout.on("data", (chunk) => { child.__output += chunk; });
  child.stderr.on("data", (chunk) => { child.__output += chunk; });
  return child;
}

async function waitForUrl(url) {
  let lastError;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw lastError || new Error(`Worker did not start: ${url}`);
}

async function waitForWorkerReady(child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Worker exited before becoming ready:\n${child.__output}`);
    if (/http:\/\/127\.0\.0\.1:8810|Ready on|Ready at/i.test(child.__output)) return;
    await delay(250);
  }
  throw new Error(`Worker did not become ready without an HTTP request:\n${child.__output}`);
}

function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
}

function runSecuritySql(sql) {
  runWrangler("security-worker", ["d1", "execute", "security-db", "--local", "--command", sql]);
}

function disableGlobalRuntime() {
  runSecuritySql(`UPDATE security_runtime_state
    SET passkey_session_epoch = passkey_session_epoch + 1,
        switch_observed_enabled = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND switch_observed_enabled = 1`);
}

function enableGlobalRuntime() {
  runSecuritySql(`UPDATE security_runtime_state
    SET switch_observed_enabled = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND switch_observed_enabled = 0`);
}

function cleanupSecurityFixture() {
  runSecuritySql(`
    DROP TRIGGER IF EXISTS fail_credential_revoke_audit;
    DROP TRIGGER IF EXISTS fail_synchronous_login_audit;
    DELETE FROM security_active_sessions WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    ) OR identity_id IN ('${identityId}', 'primary-admin', 'audit_admin', '${statusAdminIdentityId}', '${readinessIdentityId}', 'shared_cloud_test', '${legacyNestedIdentityId}');
    DELETE FROM security_audit_events WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_tcloud_client_vaults WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_setup_sessions WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_handoffs WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_challenges WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_invitations WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_service_links WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_credentials WHERE identity_id IN (
      SELECT id FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %'
    );
    DELETE FROM security_identities
      WHERE display_name IN ('Cancelled Invitation Test', 'Multiple Invitation Test', 'Pending Approval', 'Identity Disable Test', 'Identity Disable Replacement') OR display_name LIKE 'Invitation Expiry Contract %';
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id = '${identityId}';
    DELETE FROM security_tcloud_client_vaults WHERE identity_id = '${identityId}';
    DELETE FROM security_setup_sessions WHERE identity_id = '${identityId}';
    DELETE FROM security_handoffs WHERE identity_id = '${identityId}';
    DELETE FROM security_challenges WHERE identity_id = '${identityId}';
    DELETE FROM security_invitations WHERE identity_id = '${identityId}';
    DELETE FROM security_service_links WHERE identity_id = '${identityId}';
    DELETE FROM security_credentials WHERE identity_id = '${identityId}';
    DELETE FROM security_identities WHERE id = '${identityId}';
    DELETE FROM security_credentials WHERE identity_id = 'audit_admin';
    DELETE FROM security_credentials WHERE identity_id = '${statusAdminIdentityId}';
    DELETE FROM security_identities WHERE id = '${statusAdminIdentityId}';
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_tcloud_client_vaults WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_handoffs WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_challenges WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_invitations WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_service_links WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_credentials WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_identities WHERE id = '${readinessIdentityId}';
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id = 'primary-admin';
    DELETE FROM security_tcloud_client_vaults WHERE identity_id = 'primary-admin';
    DELETE FROM security_setup_sessions WHERE identity_id = 'primary-admin';
    DELETE FROM security_handoffs WHERE identity_id = 'primary-admin';
    DELETE FROM security_challenges WHERE identity_id = 'primary-admin';
    DELETE FROM security_invitations WHERE identity_id = 'primary-admin';
    DELETE FROM security_service_links WHERE identity_id = 'primary-admin';
    DELETE FROM security_credentials WHERE identity_id = 'primary-admin';
    DELETE FROM security_identities WHERE id = 'primary-admin';
    DELETE FROM security_service_links WHERE identity_id = 'shared_cloud_test';
    DELETE FROM security_identities WHERE id = 'shared_cloud_test';
    DELETE FROM security_service_links WHERE identity_id = '${legacyNestedIdentityId}';
    DELETE FROM security_identities WHERE id = '${legacyNestedIdentityId}';
    DELETE FROM security_identities WHERE id = 'audit_admin';
    DELETE FROM security_audit_events WHERE event_type = 'audit_pagination_fixture' OR identity_id IN ('${identityId}', 'primary-admin', 'audit_admin', '${statusAdminIdentityId}', '${readinessIdentityId}', 'shared_cloud_test', '${legacyNestedIdentityId}');
  `);
}

function auditCount(identity, eventType) {
  return queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE identity_id = '${identity}' AND event_type = '${eventType}'`);
}

async function waitForAuditCount(identity, eventType, minimum) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (auditCount(identity, eventType) >= minimum) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${eventType} audit event for ${identity}.`);
}

function serviceAuditCount(identity, service, eventType) {
  return queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_audit_events
    WHERE identity_id = '${identity}' AND service = '${service}' AND event_type = '${eventType}'`);
}

async function waitForServiceAudit(identity, service, eventType, minimum) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (serviceAuditCount(identity, service, eventType) >= minimum) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${service} ${eventType} audit event for ${identity}.`);
}

function queryNumber(directory, database, sql) {
  const result = runWrangler(directory, ["d1", "execute", database, "--local", "--command", sql]);
  const match = result.stdout.match(/"value"\s*:\s*(\d+)/);
  if (!match) throw new Error(`Could not read test account version from ${directory}.`);
  return Number(match[1]);
}

function queryText(directory, database, sql) {
  const result = runWrangler(directory, ["d1", "execute", database, "--local", "--command", sql]);
  const match = result.stdout.match(/"value"\s*:\s*"([^"]*)"/);
  if (!match) throw new Error(`Could not read text fixture from ${directory}.`);
  return match[1];
}

function runWrangler(directory, args) {
  const result = spawnSync(process.execPath, [wranglerPath(directory), ...args], {
    cwd: `${repository}${directory}`, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function wranglerPath(directory) {
  if (directory === "ai-worker") return `${repository}node_modules/wrangler/bin/wrangler.js`;
  return `${repository}${directory}/node_modules/wrangler/bin/wrangler.js`;
}

function databaseName(directory) {
  return ({ "security-worker": "security-db", "cloud-worker": "cloud-db", "diary-worker": "diary-db", "billing-worker": "billing-db", "ai-worker": "ai-db" })[directory];
}

function sessionPath(name) {
  return ({ cloud: "/cloud/api/session", diary: "/diary/api/session", billing: "/billing/api/session" })[name];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
