import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sessionSecret = "passkey-session-integration-secret";
const securitySessionSecret = "security-integration-secret";
const identityId = "passkey_session_test";
const credentialId = "passkey-session-credential";
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
  `);

  const diaryVersion = queryNumber("diary-worker", "diary-db", "SELECT session_version AS value FROM diary_accounts WHERE id = 'main-user'");
  const billingVersion = queryNumber("billing-worker", "billing-db", "SELECT session_version AS value FROM billing_accounts WHERE id = 'owner'");

  processes.push(startWorker("security-worker", 8810, [
    "SESSION_SECRET:security-integration-secret", "AUDIT_IP_SALT:security-integration-salt",
    "PASSKEY_ENABLED:true", "ALLOW_LOCAL_HTTP:true", "EXPECTED_ORIGIN:http://127.0.0.1:8810"
  ]));
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
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
      Cookie: `troom_security_admin=${signSecurityCookie({ kind: "admin", identityId: "audit_admin", credentialId: "audit-credential" })}`
    }
  });
  assert.equal(failedAtomicRevoke.status, 500, "injected audit failure must fail the operation");
  assert.equal(queryText("security-worker", "security-db", "SELECT status AS value FROM security_credentials WHERE credential_id = 'audit-credential'"), "active",
    "D1 batch must roll back credential revoke when its audit INSERT fails");
  runSecuritySql("DROP TRIGGER fail_credential_revoke_audit");
  const longCredentialId = "A".repeat(4096);
  runSecuritySql(`INSERT INTO security_credentials
    (credential_id, identity_id, public_key, prf_salt, status, approved_at)
    VALUES ('${longCredentialId}', 'audit_admin', 'long-public-key', 'long-prf-salt', 'active', CURRENT_TIMESTAMP)`);
  const longCredentialRevoke = await fetch(`http://127.0.0.1:8810/security/api/credentials/${longCredentialId}/revoke`, {
    method: "POST",
    headers: {
      Origin: "http://127.0.0.1:8810",
      "Content-Type": "application/json",
      Cookie: `troom_security_admin=${signSecurityCookie({ kind: "admin", identityId: "audit_admin", credentialId: "audit-credential" })}`
    }
  });
  assert.equal(longCredentialRevoke.status, 200, "a valid 3072-byte WebAuthn credential ID can be revoked");
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${setupToken}` },
      body: JSON.stringify(vaultBody)
    });
    assert.equal(response.status, 200, `idempotent client-vault attempt ${attempt + 1}: ${await response.text()}`);
  }
  assert.equal(queryNumber("security-worker", "security-db", `SELECT COUNT(*) AS value FROM security_tcloud_client_vaults WHERE credential_id = '${credentialId}'`), 1);
  const changedKey = await fetch("http://127.0.0.1:8810/security/api/tcloud/envelope", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:8810", "Content-Type": "application/json", Cookie: `troom_security_setup=${setupToken}` },
    body: JSON.stringify({ ...vaultBody, publicKeyJwk: { ...vaultBody.publicKeyJwk, n: "BQYHCA" } })
  });
  assert.equal(changedKey.status, 409, "normal retry must not rotate the credential RSA key");
  const resumedSetup = await fetch("http://127.0.0.1:8810/security/api/setup/status", { headers: { Cookie: `troom_security_setup=${setupToken}` } });
  assert.equal(resumedSetup.status, 200);
  assert.equal((await resumedSetup.json()).tcloudReady, true, "setup cookie resumes after a page/browser restart");
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

  stopServiceWorkers();
  await startServiceWorkers(false);
  await assertAccess(passkeyCookies, false, "PASSKEY_ENABLED=false");
  await assertAccess(passwordCookies, true, "password sessions while passkeys are disabled");

  stopServiceWorkers();
  await startServiceWorkers(true);
  await assertAccess(replacementCookies, false, "old passkey cookies stay revoked after kill switch is re-enabled");
  const newEpochCookies = createServiceCookies("passkey", diaryVersion, billingVersion, 2, replacementLinks);
  await assertAccess(newEpochCookies, true, "new passkey login after kill switch uses the new epoch");
  await assertAccess(passwordCookies, true, "password sessions remain valid across the kill-switch cycle");

  console.log("service passkey revocation HTTP integration: ok");
} finally {
  for (const child of processes.splice(0).reverse()) stopProcess(child);
  cleanupSecurityFixture();
}

async function startServiceWorkers(passkeysEnabled) {
  const enabled = passkeysEnabled ? "true" : "false";
  processes.push(startWorker("cloud-worker", services.cloud.port, [
    `SESSION_SECRET:${sessionSecret}`, "LOGIN_ID:integration@example.test", "ACCOUNT_KDF_ID:integration-account",
    `PASSKEY_ENABLED:${enabled}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("diary-worker", services.diary.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${enabled}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  processes.push(startWorker("billing-worker", services.billing.port, [
    `SESSION_SECRET:${sessionSecret}`, "SESSION_VERSION:3", `PASSKEY_ENABLED:${enabled}`, "ALLOW_LOCAL_HTTP:true"
  ]));
  await Promise.all(Object.entries(services).map(([name, service]) =>
    waitForUrl(`http://127.0.0.1:${service.port}${sessionPath(name)}`)));
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

function stopProcess(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
}

function runSecuritySql(sql) {
  runWrangler("security-worker", ["d1", "execute", "security-db", "--local", "--command", sql]);
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
