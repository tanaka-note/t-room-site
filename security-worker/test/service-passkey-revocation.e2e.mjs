import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sessionSecret = "passkey-session-integration-secret";
const securitySessionSecret = "security-integration-secret";
const identityId = "passkey_session_test";
const credentialId = Buffer.from("passkey-session-credential").toString("base64url");
const readinessIdentityId = "cloud_readiness_test";
const readinessCredentialA = Buffer.from("cloud-readiness-credential-a").toString("base64url");
const readinessCredentialB = Buffer.from("cloud-readiness-credential-b").toString("base64url");
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
  for (const directory of ["security-worker", "cloud-worker", "diary-worker", "billing-worker"]) {
    runWrangler(directory, ["d1", "migrations", "apply", databaseName(directory), "--local"]);
  }
  cleanupSecurityFixture();
  runSecuritySql(`
    UPDATE security_runtime_state SET passkey_session_epoch = 1, switch_observed_enabled = 1 WHERE id = 1;
    INSERT INTO security_identities (id, display_name, status) VALUES ('${identityId}', 'Passkey Session Test', 'active');
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('${credentialId}', '${identityId}', 'test-public-key', 'test-prf-salt', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, display_label, status)
      VALUES
      ('${services.cloud.linkId}', '${identityId}', 'cloud', '${services.cloud.accountId}', 'Cloud Test', 'active'),
      ('${services.diary.linkId}', '${identityId}', 'diary', '${services.diary.accountId}', 'Diary Test', 'active'),
      ('${services.billing.linkId}', '${identityId}', 'billing', '${services.billing.accountId}', 'Billing Test', 'active');
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('setup-cloud-member', '${identityId}', 'cloud', 'folder-member', 42, 'Setup Cloud', 'pending');
    INSERT INTO security_identities (id, display_name, status, is_security_admin)
      VALUES ('audit_admin', 'Audit Failure Admin', 'active', 1);
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('audit-credential', 'audit_admin', 'test-public-key', 'test-prf-salt', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_identities (id, display_name, status)
      VALUES ('${readinessIdentityId}', 'Cloud Readiness Test', 'active');
    INSERT INTO security_credentials
      (credential_id, identity_id, public_key, prf_salt, status, approved_at)
      VALUES ('${readinessCredentialA}', '${readinessIdentityId}', 'public-a', 'c2FsdC1h', 'active', CURRENT_TIMESTAMP),
             ('${readinessCredentialB}', '${readinessIdentityId}', 'public-b', 'c2FsdC1i', 'active', CURRENT_TIMESTAMP);
    INSERT INTO security_service_links
      (id, identity_id, service, service_account_id, cloud_root_folder_id, display_label, status)
      VALUES ('readiness-cloud-link', '${readinessIdentityId}', 'cloud', 'folder-member', 42, 'Cloud Readiness', 'active');
    INSERT INTO security_tcloud_client_vaults
      (credential_id, identity_id, public_key_jwk, public_key_fingerprint, encrypted_payload, payload_iv)
      VALUES ('${readinessCredentialA}', '${readinessIdentityId}', '{"kty":"RSA"}', 'fingerprint-a', 'private-a', 'iv-a'),
             ('${readinessCredentialB}', '${readinessIdentityId}', '{"kty":"RSA"}', 'fingerprint-b', 'private-b', 'iv-b');
    INSERT INTO security_tcloud_key_envelopes
      (id, identity_id, credential_id, service_link_id, envelope_type, wrapped_key)
      VALUES ('readiness-envelope-a', '${readinessIdentityId}', '${readinessCredentialA}', 'readiness-cloud-link', 'folder_key_rsa', 'wrapped-a');
  `);

  const diaryVersion = queryNumber("diary-worker", "diary-db", "SELECT session_version AS value FROM diary_accounts WHERE id = 'main-user'");
  const billingVersion = queryNumber("billing-worker", "billing-db", "SELECT session_version AS value FROM billing_accounts WHERE id = 'owner'");

  startSecurityWorker(true);
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  const oldAdminCookie = signSecurityCookie({ kind: "admin", identityId: "audit_admin", credentialId: "audit-credential", passkeySessionEpoch: 1 });
  const oldIdentityCookie = signSecurityCookie({ kind: "identity", identityId, credentialId, passkeySessionEpoch: 1 });
  assert.equal(await securityAdminAuthenticated(oldAdminCookie), true, "current-epoch Security admin cookie is accepted");
  assert.equal(await securityIdentityHandoff(oldIdentityCookie), 200, "current-epoch Security identity cookie is accepted");
  assert.deepEqual(await cloudAuthenticationCredentialIds(), [readinessCredentialA], "only the credential with a folder envelope is a Cloud login candidate");
  const readinessCookieA = signSecurityCookie({ kind: "identity", identityId: readinessIdentityId, credentialId: readinessCredentialA, passkeySessionEpoch: 1 });
  const readinessCookieB = signSecurityCookie({ kind: "identity", identityId: readinessIdentityId, credentialId: readinessCredentialB, passkeySessionEpoch: 1 });
  assert.equal(await securityCloudHandoff(readinessCookieA), 200, "credential A can create a handoff for its delegated folder");
  assert.equal(await securityCloudHandoff(readinessCookieB), 403, "credential B cannot select an active link without its own envelope");
  let readinessDetail = await securityIdentityDetail(readinessIdentityId, oldAdminCookie);
  assert.equal(readinessDetail.approvalCandidates.find((item) => item.credentialId === readinessCredentialB)?.cloudPendingCount, 1,
    "the second credential is shown as pending Cloud delegation");
  const delegatedB = await approveCredentialCloudLink(readinessIdentityId, readinessCredentialB, oldAdminCookie);
  assert.equal(delegatedB.tcloudPasskeyReady, true, "admin delegation activates credential B readiness without replacing the credential");
  assert.deepEqual((await cloudAuthenticationCredentialIds()).sort(), [readinessCredentialA, readinessCredentialB].sort(),
    "the second credential becomes a Cloud candidate only after delegation");
  assert.equal(await securityCloudHandoff(readinessCookieB), 200, "credential B can create a handoff after its own delegation");
  readinessDetail = await securityIdentityDetail(readinessIdentityId, oldAdminCookie);
  assert.equal(readinessDetail.approvalCandidates.some((item) => item.credentialId === readinessCredentialB), false);
  for (const malformed of ["%", "***", "a", "a.b.c", "e30.invalid-signature"]) {
    const response = await fetch("http://127.0.0.1:8810/security/api/status", { headers: { Cookie: `troom_security_admin=${malformed}` } });
    assert.equal(response.status, 200, `malformed Security cookie ${malformed} must not cause 500`);
    assert.equal((await response.json()).adminAuthenticated, false);
  }
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
  const setupToken = "setup-session-token-for-retry-test-1234567890";
  const setupTokenHash = createHash("sha256").update(setupToken).digest("base64url");
  runSecuritySql(`INSERT INTO security_setup_sessions
    (id, token_hash, identity_id, credential_id, expires_at, last_user_verification_at)
    VALUES ('setup-retry', '${setupTokenHash}', '${identityId}', '${credentialId}', ${Math.floor(Date.now() / 1000) + 3600}, ${Math.floor(Date.now() / 1000)})`);
  const vaultBody = {
    serviceLinkId: "setup-cloud-member", envelopeType: "client_private_prf",
    publicKeyJwk: { kty: "RSA", alg: "RSA-OAEP-256", key_ops: ["encrypt"], ext: true, n: "AQIDBA", e: "AQAB" },
    encryptedPayload: "encrypted-private-key", payloadIv: "encrypted-private-key-iv"
  };
  const firstVaultSave = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${setupToken}` },
    body: JSON.stringify(vaultBody)
  });
  assert.equal(firstVaultSave.status, 200, `initial client-vault save: ${await firstVaultSave.text()}`);
  const repeatedVaultSave = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${setupToken}` },
    body: JSON.stringify(vaultBody)
  });
  assert.equal(repeatedVaultSave.status, 401, "a completed setup session cannot register an envelope again");
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_tcloud_client_vaults WHERE credential_id = '${credentialId}'`), 1);
  const changedKey = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${setupToken}` },
    body: JSON.stringify({ ...vaultBody, publicKeyJwk: { ...vaultBody.publicKeyJwk, n: "BQYHCA" } })
  });
  assert.equal(changedKey.status, 401, "completed setup authority cannot rotate the credential RSA key");
  const resumedSetup = await fetch("http://127.0.0.1:8810/security/api/setup/status", { headers: { Cookie: `troom_security_setup=${setupToken}` } });
  assert.equal(resumedSetup.status, 200);
  const resumedSetupBody = await resumedSetup.json();
  assert.equal(resumedSetupBody.active, false);
  assert.equal(resumedSetupBody.completed, true);
  assert.equal(resumedSetupBody.tcloudReady, true, "a lost success response is recoverable as a read-only completed state");
  runSecuritySql("UPDATE security_setup_sessions SET status = 'active', expires_at = 1 WHERE id = 'setup-retry'");
  assert.equal((await readSetupStatus(setupToken)).active, false, "expired setup session is rejected");
  runSecuritySql(`UPDATE security_setup_sessions SET expires_at = ${Math.floor(Date.now() / 1000) + 3600} WHERE id = 'setup-retry'; UPDATE security_credentials SET status = 'revoked' WHERE credential_id = '${credentialId}'`);
  assert.equal((await readSetupStatus(setupToken)).active, false, "revoked credential invalidates setup session");
  runSecuritySql(`UPDATE security_credentials SET status = 'active' WHERE credential_id = '${credentialId}'; UPDATE security_identities SET status = 'disabled' WHERE id = '${identityId}'`);
  assert.equal((await readSetupStatus(setupToken)).active, false, "disabled Identity invalidates setup session");
  runSecuritySql(`UPDATE security_identities SET status = 'active' WHERE id = '${identityId}'; UPDATE security_setup_sessions SET status = 'completed' WHERE id = 'setup-retry'`);
  assert.equal((await readSetupStatus(setupToken)).completed, true, "completed setup remains visible only as read-only completion state");
  await startServiceWorkers(true);

  const passkeyCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 1);
  const passwordCookies = createServiceCookies("password", diaryVersion, billingVersion);
  await waitForServiceBindings(passkeyCookies);
  await assertAccess(passkeyCookies, true, "active passkey sessions");
  await assertRollingPasskeySessions(passkeyCookies);

  runSecuritySql(`UPDATE security_credentials SET status = 'revoked' WHERE credential_id = '${credentialId}'`);
  await assertAccess(passkeyCookies, false, "credential revoke");
  await assertAccess(passwordCookies, true, "password sessions after credential revoke");

  runSecuritySql(`UPDATE security_credentials SET status = 'active', revoked_at = NULL WHERE credential_id = '${credentialId}'`);
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
  assert.equal(await securityIdentityHandoff(newIdentityCookie), 200, "new Security identity cookie uses the new epoch");

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

  console.log("service passkey revocation HTTP integration: ok");
} finally {
  for (const child of processes.splice(0).reverse()) stopProcess(child);
  cleanupSecurityFixture();
}

async function startServiceWorkers(passkeysEnabled) {
  const enabledByService = typeof passkeysEnabled === "object"
    ? passkeysEnabled
    : Object.fromEntries(Object.keys(services).map((name) => [name, Boolean(passkeysEnabled)]));
  processes.push(startWorker("cloud-worker", services.cloud.port, [
    `SESSION_SECRET:${sessionSecret}`, "LOGIN_ID:integration@example.test", "ACCOUNT_KDF_ID:integration-account",
    `PASSKEY_ENABLED:${String(enabledByService.cloud)}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("diary-worker", services.diary.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${String(enabledByService.diary)}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("billing-worker", services.billing.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${String(enabledByService.billing)}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  await Promise.all(Object.entries(services).map(([name, service]) =>
    waitForUrl(`http://127.0.0.1:${service.port}${sessionPath(name)}`)));
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

async function securityIdentityHandoff(cookie) {
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/handoff", {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_identity=${cookie}`
    },
    body: JSON.stringify({ service: "diary" })
  });
  return response.status;
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
  const response = await fetch("http://127.0.0.1:8810/security/api/auth/options", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json" },
    body: JSON.stringify({ service: "cloud" })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.options.allowCredentials.map((item) => item.id);
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

async function approveCredentialCloudLink(identity, credential, cookie) {
  const response = await fetch(`http://127.0.0.1:8810/security/api/identities/${identity}/approve`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_admin=${cookie}`
    },
    body: JSON.stringify({ credentialId: credential, cloudEnvelopes: [{ serviceLinkId: "readiness-cloud-link", wrappedKey: "wrapped-b" }] })
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

async function assertRollingPasskeySessions(cookies) {
  for (const [name, service] of Object.entries(services)) {
    const first = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
      headers: { Cookie: `${service.cookie}=${cookies[name]}` }
    });
    assert.equal(first.status, 200, `${name} rolling session first access`);
    const refreshed = first.headers.get("set-cookie")?.match(new RegExp(`${service.cookie}=([^;]+)`))?.[1];
    assert.ok(refreshed, `${name} must refresh its authenticated session`);
    const second = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
      headers: { Cookie: `${service.cookie}=${refreshed}` }
    });
    assert.equal(second.status, 200, `${name} refreshed passkey session must retain the epoch`);
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
  const encoded = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const signature = createHmac("sha256", securitySessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function startWorker(directory, port, vars) {
  const child = spawn(process.execPath, [wranglerPath(directory), "dev", "--local", "--port", String(port),
    "--compatibility-date", "2026-08-06",
    ...vars.flatMap((value) => ["--var", value])], {
    cwd: `${repository}${directory}`, stdio: ["ignore", "pipe", "pipe"]
  });
  child.__directory = directory;
  child.__output = "";
  child.stdout.on("data", (chunk) => { child.__output += chunk; });
  child.stderr.on("data", (chunk) => { child.__output += chunk; });
  return child;
}

async function waitForUrl(url) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw lastError || new Error(`Worker did not start: ${url}`);
}

async function waitForWorkerReady(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
    DELETE FROM security_identities WHERE id = 'audit_admin';
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_tcloud_client_vaults WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_handoffs WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_challenges WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_invitations WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_service_links WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_credentials WHERE identity_id = '${readinessIdentityId}';
    DELETE FROM security_identities WHERE id = '${readinessIdentityId}';
  `);
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
  return `${repository}${directory}/node_modules/wrangler/bin/wrangler.js`;
}

function databaseName(directory) {
  return ({ "security-worker": "security-db", "cloud-worker": "cloud-db", "diary-worker": "diary-db", "billing-worker": "billing-db" })[directory];
}

function sessionPath(name) {
  return ({ cloud: "/cloud/api/session", diary: "/diary/api/session", billing: "/billing/api/session" })[name];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
