import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sessionSecret = "passkey-session-integration-secret";
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
  `);

  const diaryVersion = queryNumber("diary-worker", "diary-db", "SELECT session_version AS value FROM diary_accounts WHERE id = 'main-user'");
  const billingVersion = queryNumber("billing-worker", "billing-db", "SELECT session_version AS value FROM billing_accounts WHERE id = 'owner'");

  processes.push(startWorker("security-worker", 8810, [
    "SESSION_SECRET:security-integration-secret", "AUDIT_IP_SALT:security-integration-salt",
    "PASSKEY_ENABLED:true", "ALLOW_LOCAL_HTTP:true", "EXPECTED_ORIGIN:http://127.0.0.1:8810"
  ]));
  await waitForUrl("http://127.0.0.1:8810/security/api/status");
  await startServiceWorkers(true);

  const passkeyCookies = createServiceCookies("passkey", diaryVersion, billingVersion);
  const passwordCookies = createServiceCookies("password", diaryVersion, billingVersion);
  await waitForServiceBindings(passkeyCookies);
  await assertAccess(passkeyCookies, true, "active passkey sessions");

  runSecuritySql(`UPDATE security_credentials SET status = 'revoked' WHERE credential_id = '${credentialId}'`);
  await assertAccess(passkeyCookies, false, "credential revoke");
  await assertAccess(passwordCookies, true, "password sessions after credential revoke");

  runSecuritySql(`UPDATE security_credentials SET status = 'active', revoked_at = NULL WHERE credential_id = '${credentialId}'`);
  for (const [name, service] of Object.entries(services)) {
    runSecuritySql(`UPDATE security_service_links SET status = 'disabled' WHERE id = '${service.linkId}'`);
    await assertSingleAccess(name, passkeyCookies[name], false, `${name} service-link removal`);
    for (const otherName of Object.keys(services).filter((candidate) => candidate !== name)) {
      await assertSingleAccess(otherName, passkeyCookies[otherName], true, `${name} removal must not revoke ${otherName}`);
    }
    runSecuritySql(`UPDATE security_service_links SET status = 'active' WHERE id = '${service.linkId}'`);
  }

  stopServiceWorkers();
  await startServiceWorkers(false);
  await assertAccess(passkeyCookies, false, "PASSKEY_ENABLED=false");
  await assertAccess(passwordCookies, true, "password sessions while passkeys are disabled");

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

async function assertSingleAccess(name, cookie, expected, label) {
  const service = services[name];
  const response = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
    headers: { Cookie: `${service.cookie}=${cookie}` }
  });
  const body = await response.text();
  assert.equal(response.status, expected ? 200 : 401, `${label}: ${name} returned ${response.status}: ${body.slice(0, 300)}`);
}

function createServiceCookies(authMethod, diaryVersion, billingVersion) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const auth = authMethod === "passkey" ? { identityId, credentialId, authMethod } : { authMethod };
  return {
    cloud: signCookie({
      role: "admin", sessionId: randomUUID(), exp, version: services.cloud.version,
      ...auth, serviceLinkId: authMethod === "passkey" ? services.cloud.linkId : null,
      serviceAccountId: authMethod === "passkey" ? services.cloud.accountId : null, rootFolderId: null
    }),
    diary: signCookie({
      role: "user", accountId: services.diary.accountId, activeHouseholdId: "tanaka-household",
      accountVersion: diaryVersion, exp, version: services.diary.version,
      ...auth, serviceLinkId: authMethod === "passkey" ? services.diary.linkId : null,
      serviceAccountId: authMethod === "passkey" ? services.diary.accountId : null
    }),
    billing: signCookie({
      role: "owner", accountId: services.billing.accountId, accountVersion: billingVersion,
      globalVersion: services.billing.version, exp,
      ...auth, serviceLinkId: authMethod === "passkey" ? services.billing.linkId : null,
      serviceAccountId: authMethod === "passkey" ? services.billing.accountId : null
    })
  };
}

function signCookie(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
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
    DELETE FROM security_tcloud_key_envelopes WHERE identity_id = '${identityId}';
    DELETE FROM security_handoffs WHERE identity_id = '${identityId}';
    DELETE FROM security_challenges WHERE identity_id = '${identityId}';
    DELETE FROM security_invitations WHERE identity_id = '${identityId}';
    DELETE FROM security_service_links WHERE identity_id = '${identityId}';
    DELETE FROM security_credentials WHERE identity_id = '${identityId}';
    DELETE FROM security_identities WHERE id = '${identityId}';
  `);
}

function queryNumber(directory, database, sql) {
  const result = runWrangler(directory, ["d1", "execute", database, "--local", "--command", sql]);
  const match = result.stdout.match(/"value"\s*:\s*(\d+)/);
  if (!match) throw new Error(`Could not read test account version from ${directory}.`);
  return Number(match[1]);
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
