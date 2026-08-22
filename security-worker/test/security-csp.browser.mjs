import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium, firefox } = require("playwright");
const workspace = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const securityPublic = resolve(workspace, "security-worker/public");
const cloudPublic = resolve(workspace, "cloud-worker/public");
const dummyPassword = "security-csp-test-password";
const receivedBootstrapBodies = [];
const receivedResumeBodies = [];
const receivedPrfOptionBodies = [];
const receivedPrfVerifyBodies = [];
const receivedEnvelopeBodies = [];
const malformedPrfCredentialId = "bWFsZm9ybWVkLXByZi1vcHRpb25z";
let setupStatusBody = { active: false };
let securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
let failEnvelopeSave = false;
let registeredCredentialCount = 0;

const staticFiles = new Map([
  ["/security/", [resolve(securityPublic, "index.html"), "text/html; charset=utf-8"]],
  ["/security/security.css", [resolve(securityPublic, "security.css"), "text/css; charset=utf-8"]],
  ["/security/security.js", [resolve(securityPublic, "security.js"), "text/javascript; charset=utf-8"]],
  ["/security/passkey-client.js", [resolve(securityPublic, "passkey-client.js"), "text/javascript; charset=utf-8"]],
  ["/cloud/crypto-vault.js", [resolve(cloudPublic, "crypto-vault.js"), "text/javascript; charset=utf-8"]],
  ["/cloud/vendor/argon2.umd.min.js", [resolve(cloudPublic, "vendor/argon2.umd.min.js"), "text/javascript; charset=utf-8"]]
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/security/api/setup/status") return sendJson(response, 200, setupStatusBody);
  if (url.pathname === "/security/api/status") return sendJson(response, 200, securityStatusBody);
  if (url.pathname === "/security/api/dashboard") return sendJson(response, 200, { loginSuccess: 0, loginFailure: 0, lockouts: 0, invited: 0, pendingApproval: 0, noPasskey: 0, critical: 0 });
  if (url.pathname === "/security/api/identities") return sendJson(response, 200, { identities: [] });
  if (url.pathname === "/security/api/audit") return sendJson(response, 200, { events: [] });
  if (url.pathname === "/security/api/identities/primary-admin") return sendJson(response, 200, {
    identity: { id: "primary-admin", displayName: "第一管理者", status: "active", isSecurityAdmin: true },
    links: [{ id: "primary-cloud", service: "cloud", service_account_id: "admin", status: "pending" }],
    credentials: [], invitations: [], approvalCandidates: [], adminKeyEnvelopes: []
  });
  if (url.pathname === "/security/api/tcloud/admin-config") return sendJson(response, 200, { initialized: true, cryptoVersion: 1 });
  if (url.pathname === "/cloud/api/auth-mode") return sendJson(response, 200, { credentialSalt: "AAECAwQFBgcICQoLDA0ODw" });
  if (url.pathname === "/security/api/bootstrap/options") {
    const body = JSON.parse(await readBody(request));
    receivedBootstrapBodies.push(body);
    return sendJson(response, 200, {
      challengeId: "test-challenge",
      options: {
        challenge: "AAECAwQFBgcICQoLDA0ODw",
        rp: { id: "127.0.0.1", name: "T-ROOM" },
        user: { id: "cHJpbWFyeS1hZG1pbg", name: "primary-admin", displayName: "第一管理者" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
        timeout: 300000,
        excludeCredentials: []
      }
    });
  }
  if (url.pathname === "/security/api/bootstrap/verify") {
    const body = JSON.parse(await readBody(request));
    registeredCredentialCount += 1;
    setupStatusBody = {
      active: true, completed: false, identityId: "primary-admin", credentialId: "cmVzdW1lLWNyZWRlbnRpYWw",
      isPrimaryAdmin: true, prfEnabled: Boolean(body.prfEnabled), tcloudReady: false,
      cloudLinks: [{ id: "primary-cloud", accountId: "admin", rootFolderId: null }]
    };
    securityStatusBody = { enabled: true, initialized: true, adminAuthenticated: true };
    return sendJson(response, 201, {
      ok: true, identityId: "primary-admin", credentialId: "cmVzdW1lLWNyZWRlbnRpYWw",
      prfSalt: "AAECAwQFBgcICQoLDA0ODw", prfEnabled: setupStatusBody.prfEnabled, needsTCloudEnvelope: true
    });
  }
  if (url.pathname === "/security/api/setup/primary-admin/verify-password") {
    const body = JSON.parse(await readBody(request));
    receivedResumeBodies.push(body);
    return sendJson(response, 200, { verified: true });
  }
  if (url.pathname === "/security/api/prf/options") {
    const body = JSON.parse(await readBody(request));
    receivedPrfOptionBodies.push(body);
    const requestedCredentialId = body.credentialId || "cmVzdW1lLWNyZWRlbnRpYWw";
    const malformed = requestedCredentialId === malformedPrfCredentialId;
    return sendJson(response, 200, {
      challengeId: "resume-prf-challenge",
      credentialId: requestedCredentialId,
      prfSalt: "AAECAwQFBgcICQoLDA0ODw",
      options: {
        challenge: "AAECAwQFBgcICQoLDA0ODw",
        rpId: "127.0.0.1",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: requestedCredentialId }],
        extensions: { prf: { evalByCredential: { [requestedCredentialId]: { first: malformed ? { 0: 0, 1: 1 } : "AAECAwQFBgcICQoLDA0ODw" } } } }
      }
    });
  }
  if (url.pathname === "/security/api/prf/verify") {
    receivedPrfVerifyBodies.push(JSON.parse(await readBody(request)));
    return sendJson(response, 200, { verified: true });
  }
  if (url.pathname === "/security/api/tcloud/envelope") {
    receivedEnvelopeBodies.push(JSON.parse(await readBody(request)));
    if (failEnvelopeSave) return sendJson(response, 503, { error: "一時的なT-Cloud障害" });
    setupStatusBody = { ...setupStatusBody, active: false, completed: true, tcloudReady: true };
    return sendJson(response, 200, { ok: true });
  }
  if (url.pathname === "/assets/pwa-auto-update.js") {
    response.writeHead(200, responseHeaders("text/javascript; charset=utf-8"));
    response.end("// The CSP browser regression test intentionally disables update traffic.\n");
    return;
  }
  if (url.pathname === "/security/csp-eval-probe.js") {
    response.writeHead(200, responseHeaders("text/javascript; charset=utf-8"));
    response.end("try { Function('return 1')(); window.__troomJavascriptEvalAllowed = true; } catch { window.__troomJavascriptEvalAllowed = false; }");
    return;
  }
  const staticFile = staticFiles.get(url.pathname);
  if (!staticFile) {
    response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
    return;
  }
  response.writeHead(200, responseHeaders(staticFile[1]));
  response.end(await readFile(staticFile[0]));
});

function responseHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": SECURITY_CONTENT_SECURITY_POLICY,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, responseHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function browserExecutable(name) {
  const configured = process.env[`TROOM_${name.toUpperCase()}_EXECUTABLE`];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const playwrightFirefox = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("firefox-"))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .map((entry) => join(playwrightRoot, entry.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [...playwrightFirefox, "C:/Program Files/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function verifyBrowser(browserType, name, origin) {
  const executablePath = browserExecutable(name);
  if (!executablePath) return `${name}: skipped (browser unavailable)`;
  const browser = await browserType.launch({ executablePath, headless: true });
  try {
    setupStatusBody = { active: false };
    securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
    failEnvelopeSave = false;
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const credentialId = "cmVzdW1lLWNyZWRlbnRpYWw";
      const bytes = new TextEncoder().encode(credentialId);
      const scenario = () => new URL(location.href).searchParams.get("scenario") || "csp";
      const assertion = (prfAvailable) => ({
        id: credentialId,
        rawId: bytes.buffer,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
          authenticatorData: new Uint8Array([4, 5, 6]).buffer,
          signature: new Uint8Array([7, 8, 9]).buffer,
          userHandle: null
        },
        getClientExtensionResults: () => ({ prf: prfAvailable ? { results: { first: new Uint8Array([10, 11, 12]).buffer } } : {} })
      });
      const registration = (prfEnabled) => ({
        id: credentialId,
        rawId: bytes.buffer,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
          attestationObject: new Uint8Array([4, 5, 6]).buffer,
          getTransports: () => ["internal"],
          getPublicKeyAlgorithm: () => -7
        },
        getClientExtensionResults: () => ({ prf: { enabled: prfEnabled }, credProps: { rk: true } })
      });
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
          get: async () => {
            window.__troomWebAuthnGetCalled = true;
            window.__troomWebAuthnGetCount = Number(window.__troomWebAuthnGetCount || 0) + 1;
            if (["bootstrap-prf-unsupported", "bootstrap-transient", "primary-retry"].includes(scenario())) {
              return assertion(scenario() !== "bootstrap-prf-unsupported");
            }
            throw new DOMException("CSP regression test reached resumed WebAuthn", "NotAllowedError");
          },
          create: async () => {
            window.__troomWebAuthnCreateCalled = true;
            window.__troomWebAuthnCreateCount = Number(window.__troomWebAuthnCreateCount || 0) + 1;
            if (scenario() === "bootstrap-prf-unsupported") return registration(false);
            if (scenario() === "bootstrap-transient") return registration(true);
            throw new DOMException("CSP regression test reached WebAuthn", "NotAllowedError");
          }
        }
      });
      Object.defineProperty(window, "TRoomCrypto", {
        configurable: true,
        set(value) {
          Object.defineProperty(window, "TRoomCrypto", {
            configurable: true,
            value: Object.freeze({
              ...value,
              wrapAdminPrivateKeyForPasskey: async () => ({ encryptedPayload: "encrypted-admin-private-key", payloadIv: "admin-private-key-iv" })
            })
          });
        }
      });
    });
    const consoleErrors = [];
    context.on("page", (testPage) => {
      testPage.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
      testPage.on("pageerror", (error) => consoleErrors.push(error.message));
    });
    const page = await context.newPage();
    await page.goto(`${origin}/security/`, { waitUntil: "load" });
    const base64UrlValidation = await page.evaluate(() => {
      const invalidValues = [{ 0: 1 }, "", "a", "AA=", "AB", "***"];
      return {
        validLength: TRoomPasskeys.fromBase64Url("AA").byteLength,
        invalid: invalidValues.map((value) => {
          try {
            TRoomPasskeys.fromBase64Url(value);
            return { rejected: false };
          } catch (error) {
            return { rejected: true, name: error.name, message: error.message };
          }
        })
      };
    });
    assert.equal(base64UrlValidation.validLength, 1, `${name}: canonical Base64URL is decoded`);
    for (const result of base64UrlValidation.invalid) {
      assert.equal(result.rejected, true, `${name}: malformed WebAuthn JSON/Base64URL is rejected`);
      assert.equal(result.name, "PasskeyOptionsError");
      assert.match(result.message, /パスキーの認証情報を読み取れませんでした/);
    }
    const verifyCountBeforeMalformed = receivedPrfVerifyBodies.length;
    const malformedPrfResult = await page.evaluate(async (credentialId) => {
      try {
        await TRoomPasskeys.obtainPrf(credentialId);
        return { rejected: false };
      } catch (error) {
        return { rejected: true, name: error.name, message: error.message, getCalled: Boolean(window.__troomWebAuthnGetCalled) };
      }
    }, malformedPrfCredentialId);
    assert.equal(malformedPrfResult.rejected, true, `${name}: malformed PRF JSON is rejected before WebAuthn`);
    assert.equal(malformedPrfResult.name, "PasskeyOptionsError");
    assert.match(malformedPrfResult.message, /パスキーの認証情報を読み取れませんでした/);
    assert.equal(malformedPrfResult.getCalled, false, `${name}: malformed options never reach navigator.credentials.get`);
    assert.equal(receivedPrfVerifyBodies.length, verifyCountBeforeMalformed,
      `${name}: malformed option decoding never reports PRF unsupported to the server`);
    await page.locator("#bootstrap-id").fill("admin");
    await page.locator("#bootstrap-password").fill(dummyPassword);
    await page.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await page.waitForFunction(() => window.__troomWebAuthnCreateCalled === true, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => typeof globalThis.hashwasm?.argon2id), "function");
    assert.equal(await page.evaluate(() => typeof globalThis.TRoomCrypto?.deriveAccountCredentials), "function");
    assert.ok(!consoleErrors.some((message) => /Content Security Policy|WebAssembly\.compile|CompileError/i.test(message)), `${name}: ${consoleErrors.join("\n")}`);
    await page.evaluate(() => new Promise((resolveProbe) => {
      const script = document.createElement("script");
      script.src = "/security/csp-eval-probe.js";
      script.onload = resolveProbe;
      script.onerror = resolveProbe;
      document.head.append(script);
    }));
    assert.equal(await page.evaluate(() => window.__troomJavascriptEvalAllowed), false, `${name}: normal JavaScript eval must remain blocked`);
    setupStatusBody = {
      active: true, identityId: "resume_user", credentialId: "cmVzdW1lLWNyZWRlbnRpYWw",
      isPrimaryAdmin: false, prfEnabled: true, tcloudReady: false,
      cloudLinks: [{ id: "cloud-2", accountId: "folder-member", rootFolderId: 2 }, { id: "cloud-10", accountId: "folder-member", rootFolderId: 10 }]
    };
    const resumed = await context.newPage();
    await resumed.goto(`${origin}/security/`, { waitUntil: "load" });
    const resumeButton = resumed.getByRole("button", { name: "T-Cloudの準備を再開" });
    await resumeButton.waitFor();
    assert.equal(await resumed.locator("#invite-view").isVisible(), true, `${name}: setup session resumes after reload`);
    await resumeButton.click();
    await resumed.waitForFunction(() => window.__troomWebAuthnGetCalled === true, null, { timeout: 30000 });
    setupStatusBody = { active: false };
    securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
    registeredCredentialCount = 0;
    const unsupported = await context.newPage();
    await unsupported.goto(`${origin}/security/?scenario=bootstrap-prf-unsupported`, { waitUntil: "load" });
    await unsupported.locator("#bootstrap-id").fill("admin");
    await unsupported.locator("#bootstrap-password").fill(dummyPassword);
    await unsupported.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await unsupported.locator("#dashboard-panel .stats").waitFor({ timeout: 30000 });
    assert.equal(await unsupported.locator("#admin-view").isVisible(), true, `${name}: PRF unsupported must not block Security Center`);
    assert.equal(await unsupported.locator("#tcloud-setup-notice").isVisible(), true);
    assert.match(await unsupported.locator("#tcloud-setup-status").textContent(), /この端末ではT-Cloudのパスキー復号に対応していません/);
    assert.equal(await unsupported.locator("#tcloud-setup-resume").isVisible(), false, `${name}: PRF unsupported must not promise a retry`);
    assert.match(await unsupported.locator("#message").textContent(), /Security Center・日記・請求書のパスキー登録は完了しました/);
    assert.equal(registeredCredentialCount, 1);
    await unsupported.reload({ waitUntil: "load" });
    await unsupported.locator("#dashboard-panel .stats").waitFor();
    assert.equal(await unsupported.locator("#tcloud-setup-notice").isVisible(), true, `${name}: warning survives reload without blocking admin UI`);
    assert.equal(registeredCredentialCount, 1, `${name}: reload must not create a second credential`);

    setupStatusBody = { active: false };
    securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
    registeredCredentialCount = 0;
    failEnvelopeSave = true;
    const transient = await context.newPage();
    await transient.goto(`${origin}/security/?scenario=bootstrap-transient`, { waitUntil: "load" });
    await transient.locator("#bootstrap-id").fill("admin");
    await transient.locator("#bootstrap-password").fill(dummyPassword);
    await transient.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await transient.locator("#dashboard-panel .stats").waitFor({ timeout: 30000 });
    assert.equal(await transient.locator("#tcloud-setup-notice").isVisible(), true, `${name}: envelope failure is a non-blocking warning`);
    assert.equal(await transient.locator("#tcloud-setup-resume").isVisible(), true);
    assert.equal(registeredCredentialCount, 1);

    await transient.goto(`${origin}/security/?scenario=primary-retry`, { waitUntil: "load" });
    await transient.locator("#dashboard-panel .stats").waitFor();
    assert.equal(await transient.locator("#admin-view").isVisible(), true, `${name}: transient setup reload opens the normal admin UI`);
    await transient.locator("#tcloud-setup-resume").click();
    await transient.locator("#tcloud-setup-id").fill("admin");
    await transient.locator("#tcloud-setup-password").fill(dummyPassword);
    failEnvelopeSave = false;
    await transient.getByRole("button", { name: "同じパスキーでT-Cloudの準備を再開" }).click();
    await transient.waitForFunction(() => window.__troomWebAuthnGetCalled === true, null, { timeout: 30000 });
    await transient.locator("#tcloud-setup-notice").waitFor({ state: "hidden", timeout: 30000 });
    assert.notEqual(await transient.evaluate(() => window.__troomWebAuthnCreateCalled), true,
      `${name}: primary-admin setup resume must not create a second credential`);
    assert.equal(registeredCredentialCount, 1, `${name}: setup retry keeps exactly one credential`);
    assert.equal(receivedPrfOptionBodies.at(-1).credentialId, "cmVzdW1lLWNyZWRlbnRpYWw", `${name}: retry uses the same credential ID`);
    assert.equal(setupStatusBody.completed, true);
    assert.equal(setupStatusBody.tcloudReady, true);
    assert.ok(!consoleErrors.some((message) => /Content Security Policy|WebAssembly\.compile|Unhandled|TypeError/i.test(message)), `${name}: ${consoleErrors.join("\n")}`);
    setupStatusBody = { active: false };
    return `${name}: pass`;
  } finally {
    await browser.close();
  }
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const results = [];
  receivedBootstrapBodies.length = 0;
  receivedResumeBodies.length = 0;
  receivedPrfOptionBodies.length = 0;
  receivedPrfVerifyBodies.length = 0;
  receivedEnvelopeBodies.length = 0;
  results.push(await verifyBrowser(chromium, "chromium", origin));
  results.push(await verifyBrowser(firefox, "firefox", origin));
  const passedBrowsers = results.filter((result) => result.endsWith(": pass")).length;
  assert.equal(receivedBootstrapBodies.length, passedBrowsers * 3);
  for (const body of receivedBootstrapBodies) {
    assert.equal(body.loginId, "admin");
    assert.match(body.authProof, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!Object.hasOwn(body, "password"), "生PWをSecurity Workerへ送信しません");
    assert.ok(!JSON.stringify(body).includes(dummyPassword), "生PWをリクエスト本文へ含めません");
  }
  assert.equal(receivedResumeBodies.length, passedBrowsers);
  for (const body of receivedResumeBodies) {
    assert.equal(body.loginId, "admin");
    assert.match(body.authProof, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!Object.hasOwn(body, "password"), "resume sends authProof, never the raw password");
    assert.ok(!JSON.stringify(body).includes(dummyPassword), "resume request never contains the raw password");
  }
  assert.ok(receivedPrfOptionBodies.length >= passedBrowsers * 3, "PRF preparation and retry use WebAuthn get options");
  assert.equal(receivedPrfOptionBodies.filter((body) => body.credentialId === malformedPrfCredentialId).length, passedBrowsers,
    "each browser rejects one deliberately malformed PRF options response");
  for (const body of receivedPrfOptionBodies.filter((body) => body.credentialId !== malformedPrfCredentialId)) {
    assert.equal(body.credentialId, "cmVzdW1lLWNyZWRlbnRpYWw");
  }
  assert.equal(receivedEnvelopeBodies.length, passedBrowsers * 2, "each transient flow has one failed and one successful envelope request");
  console.log(results.join("\n"));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
