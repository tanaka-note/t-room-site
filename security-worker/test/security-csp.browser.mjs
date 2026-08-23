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
const receivedAuditQueries = [];
const receivedSetupResumeBodies = [];
const malformedPrfCredentialId = "bWFsZm9ybWVkLXByZi1vcHRpb25z";
let setupStatusBody = { active: false };
let securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
let failEnvelopeSave = false;
let registeredCredentialCount = 0;
let cancelledInviteIdentityVisible = true;
const auditEventsBody = {
  events: [
    {
      event_type: "passkey_login_success", service: "security", outcome: "success", auth_method: "passkey",
      identity_id: "primary-admin", service_account_id: "admin", service_account_label: "第一管理者", role: "admin", occurred_at: "2026-08-22T01:02:03.000Z",
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"
    },
    {
      event_type: "passkey_authentication_success", service: "diary", outcome: "success", auth_method: "passkey",
      identity_id: "primary-admin", service_account_id: "main-user", service_account_label: "田中宏知（一般ユーザー）", role: "user",
      occurred_at: "2026-08-22T01:00:00.000Z", user_agent: "Mozilla/5.0 Firefox/142.0"
    },
    {
      event_type: "session_resume", service: "diary", outcome: "success", auth_method: "password",
      identity_id: "primary-admin", service_account_id: "main-user", service_account_label: "田中宏知（一般ユーザー）", role: "user",
      occurred_at: "2026-08-22T00:58:00.000Z", user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0"
    },
    {
      event_type: "new_event_<img id=xss-marker src=x onerror=alert(1)>", service: "future-service", outcome: "future-outcome", auth_method: "future-auth",
      identity_id: "unknown_user", occurred_at: "2026-08-21T15:00:00.000Z", user_agent: "unknown-agent-<script>alert(1)</script>"
    }
  ],
  nextCursor: "browser-page-2"
};

const staticFiles = new Map([
  ["/security/", [resolve(securityPublic, "index.html"), "text/html; charset=utf-8"]],
  ["/security/security.css", [resolve(securityPublic, "security.css"), "text/css; charset=utf-8"]],
  ["/security/security.js", [resolve(securityPublic, "security.js"), "text/javascript; charset=utf-8"]],
  ["/security/security-display.js", [resolve(securityPublic, "security-display.js"), "text/javascript; charset=utf-8"]],
  ["/security/passkey-client.js", [resolve(securityPublic, "passkey-client.js"), "text/javascript; charset=utf-8"]],
  ["/cloud/crypto-vault.js", [resolve(cloudPublic, "crypto-vault.js"), "text/javascript; charset=utf-8"]],
  ["/cloud/vendor/argon2.umd.min.js", [resolve(cloudPublic, "vendor/argon2.umd.min.js"), "text/javascript; charset=utf-8"]]
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/security/api/setup/status") return sendJson(response, 200, setupStatusBody);
  if (url.pathname === "/security/api/setup/resume") {
    receivedSetupResumeBodies.push(JSON.parse(await readBody(request)));
    setupStatusBody = { ...setupStatusBody, active: true, resumable: false };
    return sendJson(response, 200, setupStatusBody);
  }
  if (url.pathname === "/security/api/status") return sendJson(response, 200, securityStatusBody);
  if (url.pathname === "/security/api/test-english-error") return sendJson(response, 400, { error: "Not found" });
  if (url.pathname === "/security/api/services") return sendJson(response, 200, { services: [
    { id: "diary", displayName: "日記", targets: [{ service: "diary", accountId: "main-user", rootFolderId: null, displayLabel: "田中宏知（一般ユーザー）", role: "user", roleLabel: "一般ユーザー", privileged: false }] },
    { id: "billing", displayName: "請求書", targets: [{ service: "billing", accountId: "owner", rootFolderId: null, displayLabel: "田中宏知（管理者）", role: "owner", roleLabel: "管理者", privileged: true }] },
    { id: "cloud", displayName: "T-Cloud", targets: [
      { service: "cloud", accountId: "folder-member", rootFolderId: 2, displayLabel: "家族写真", role: "member", roleLabel: "フォルダ利用者", privileged: false },
      { service: "cloud", accountId: "folder-member", rootFolderId: 10, displayLabel: "動画", role: "member", roleLabel: "フォルダ利用者", privileged: false }
    ] }
  ] });
  if (url.pathname === "/security/api/dashboard") return sendJson(response, 200, { loginSuccess: 0, loginFailure: 0, sessionResume: 2, lockouts: 0, invited: cancelledInviteIdentityVisible ? 1 : 0, pendingApproval: 0, noPasskey: cancelledInviteIdentityVisible ? 1 : 0, critical: 0 });
  if (url.pathname === "/security/api/identities") return sendJson(response, 200, { identities: [
    { id: "primary-admin", displayName: "第一管理者", status: "active", activeCredentials: 1, pendingCredentials: 0, lastLoginAt: "2026-08-22T01:02:03.000Z" },
    ...(cancelledInviteIdentityVisible ? [{ id: "cancelled-invite-user", displayName: "取消テストユーザー", status: "invited", activeCredentials: 0, pendingCredentials: 0 }] : [])
  ] });
  if (url.pathname === "/security/api/audit") {
    receivedAuditQueries.push(url.search);
    if (url.searchParams.get("cursor") === "browser-page-2") return sendJson(response, 200, {
      events: [{
        event_type: "entry_created", service: "billing", outcome: "success", auth_method: "password",
        identity_id: "primary-admin", service_account_id: "owner", occurred_at: "2026-08-20T15:00:00.000Z",
        user_agent: "Mozilla/5.0 Firefox/142.0"
      }],
      nextCursor: null
    });
    return sendJson(response, 200, auditEventsBody);
  }
  if (url.pathname === "/security/api/identities/primary-admin") return sendJson(response, 200, {
    identity: { id: "primary-admin", displayName: "第一管理者", status: "active", isSecurityAdmin: true },
    links: [{ id: "primary-cloud", service: "cloud", service_account_id: "admin", display_label: "T-Cloud 管理者", role: "admin", role_label: "管理者", status: "pending", protected: true }],
    credentials: [], invitations: [], approvalCandidates: [], adminKeyEnvelopes: []
  });
  if (url.pathname === "/security/api/identities/cancelled-invite-user") return sendJson(response, 200, {
    identity: { id: "cancelled-invite-user", displayName: "取消テストユーザー", status: "invited", isSecurityAdmin: false },
    links: [{ id: "cancelled-link", service: "diary", service_account_id: "main-user", display_label: "田中宏知（一般ユーザー）", role: "user", role_label: "一般ユーザー", status: "pending", protected: false }],
    credentials: [], invitations: [{ id: "cancelled-invitation", status: "active", created_at: "2026-08-23T00:00:00.000Z", expires_at: 4102444800 }],
    approvalCandidates: [], adminKeyEnvelopes: []
  });
  if (url.pathname === "/security/api/invitations/cancelled-invitation/revoke") {
    await readBody(request);
    cancelledInviteIdentityVisible = false;
    return sendJson(response, 200, { ok: true, identityRetired: true });
  }
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
  if (url.pathname === "/security/api/invite/options") {
    return sendJson(response, 200, {
      challengeId: "invite-duplicate-challenge",
      cloudLinks: [],
      options: {
        challenge: "AAECAwQFBgcICQoLDA0ODw",
        rp: { id: "127.0.0.1", name: "T-ROOM" },
        user: { id: "aW52aXRlZC11c2Vy", name: "invited-user", displayName: "招待ユーザー" },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "required", requireResidentKey: true, userVerification: "required" },
        timeout: 300000,
        excludeCredentials: [{ type: "public-key", id: "cmVzdW1lLWNyZWRlbnRpYWw" }]
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
    cancelledInviteIdentityVisible = true;
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const credentialId = "cmVzdW1lLWNyZWRlbnRpYWw";
      const bytes = new TextEncoder().encode(credentialId);
      const initialScenario = new URL(location.href).searchParams.get("scenario") || "csp";
      const scenario = () => initialScenario;
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
            if (["bootstrap-prf-unsupported", "bootstrap-prf-temporary-missing", "bootstrap-transient", "primary-retry", "general-retry"].includes(scenario())) {
              return assertion(!["bootstrap-prf-unsupported", "bootstrap-prf-temporary-missing"].includes(scenario()));
            }
            throw new DOMException("CSP regression test reached resumed WebAuthn", "NotAllowedError");
          },
          create: async () => {
            window.__troomWebAuthnCreateCalled = true;
            window.__troomWebAuthnCreateCount = Number(window.__troomWebAuthnCreateCount || 0) + 1;
            if (["bootstrap-duplicate", "invite-duplicate"].includes(scenario())) {
              throw new DOMException("The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.", "InvalidStateError");
            }
            if (scenario() === "bootstrap-prf-unsupported") return registration(false);
            if (["bootstrap-prf-temporary-missing", "bootstrap-transient"].includes(scenario())) return registration(true);
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
    const singleCloudLink = await page.evaluate(() => TRoomPasskeys.chooseLinkDialog([
      { id: "personal-cloud", displayLabel: "本人フォルダ", roleLabel: "フォルダ利用者", scopeLabel: "本人フォルダ" }
    ], "cloud"));
    assert.equal(singleCloudLink.id, "personal-cloud", `${name}: one Cloud link is selected without showing a dialog`);
    assert.equal(await page.locator(".troom-passkey-account-dialog").count(), 0,
      `${name}: one Cloud link does not add an account-selection dialog`);
    await page.evaluate(() => {
      window.__troomCloudAccountChoice = null;
      TRoomPasskeys.chooseLinkDialog([
        { id: "cloud-admin", accountId: "admin", displayLabel: "T-Cloud 管理者", roleLabel: "管理者", scopeLabel: "T-Cloud全体" },
        { id: "cloud-subadmin", accountId: "subadmin", displayLabel: "T-Cloud 副管理者", roleLabel: "副管理者", scopeLabel: "T-Cloud全体" }
      ], "cloud").then((link) => { window.__troomCloudAccountChoice = link?.id || null; });
    });
    assert.equal(await page.getByRole("heading", { name: "利用するT-Cloudアカウントを選択" }).count(), 1,
      `${name}: administrator and subadministrator links require an account choice`);
    assert.equal(await page.getByRole("button", { name: /T-Cloud 副管理者/ }).count(), 1,
      `${name}: subadministrator is visibly distinct from administrator`);
    await page.getByRole("button", { name: /T-Cloud 副管理者/ }).click();
    await page.waitForFunction(() => window.__troomCloudAccountChoice === "cloud-subadmin");
    await page.evaluate(() => {
      window.__troomCloudLinkChoice = null;
      TRoomPasskeys.chooseLinkDialog([
        { id: "cloud-admin", accountId: "admin", displayLabel: "T-Cloud 管理者", roleLabel: "管理者", scopeLabel: "T-Cloud全体" },
        { id: "personal-cloud", accountId: "folder-member", displayLabel: "本人フォルダ", roleLabel: "フォルダ利用者", scopeLabel: "本人フォルダ" }
      ], "cloud").then((link) => { window.__troomCloudLinkChoice = link?.id || null; });
    });
    assert.equal(await page.getByRole("heading", { name: "利用するT-Cloudのアカウントまたは範囲を選択" }).count(), 1,
      `${name}: mixed Cloud account and folder links use an accurate choice title`);
    await page.getByRole("button", { name: /本人フォルダ/ }).click();
    await page.waitForFunction(() => window.__troomCloudLinkChoice === "personal-cloud");
    const singleDiaryLink = await page.evaluate(() => TRoomPasskeys.chooseLinkDialog([
      { id: "diary-only", accountId: "main-user", displayLabel: "田中宏知（一般ユーザー）", roleLabel: "一般ユーザー" }
    ], "diary"));
    assert.equal(singleDiaryLink.id, "diary-only", `${name}: one Diary link is selected without showing a dialog`);
    assert.equal(await page.locator(".troom-passkey-account-dialog").count(), 0,
      `${name}: one Diary link keeps the existing direct-login behavior`);
    await page.evaluate(() => {
      window.__troomDiaryAccountChoice = null;
      TRoomPasskeys.chooseLinkDialog([
        { id: "diary-admin", accountId: "main-admin", displayLabel: "田中宏知（管理者・全体管理）", roleLabel: "管理者・全体管理" },
        { id: "diary-user", accountId: "main-user", displayLabel: "田中宏知（一般ユーザー）", roleLabel: "一般ユーザー" }
      ], "diary").then((link) => { window.__troomDiaryAccountChoice = link?.id || null; });
    });
    assert.equal(await page.getByRole("heading", { name: "利用するアカウントを選択" }).count(), 1,
      `${name}: two Diary links require an account choice`);
    assert.equal(await page.getByRole("button", { name: /田中宏知（管理者・全体管理）/ }).count(), 1,
      `${name}: the Diary administrator choice is visibly labelled`);
    assert.equal(await page.getByRole("button", { name: /田中宏知（一般ユーザー）/ }).count(), 1,
      `${name}: the Diary ordinary-user choice is visibly labelled`);
    await page.getByRole("button", { name: /田中宏知（一般ユーザー）/ }).click();
    await page.waitForFunction(() => window.__troomDiaryAccountChoice === "diary-user");
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
    await page.locator("#message").waitFor();
    assert.match(await page.locator("#message").textContent(), /キャンセルされたか、操作の有効期限が切れました/,
      `${name}: WebAuthn cancellation is shown in Japanese`);
    assert.doesNotMatch(await page.locator("#message").textContent(), /NotAllowedError|CSP regression test/i,
      `${name}: browser cancellation text is never exposed`);
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
    const localizedErrors = await page.evaluate(() => {
      const names = ["InvalidStateError", "NotAllowedError", "AbortError", "NotSupportedError", "SecurityError", "ConstraintError", "UnknownError", "OperationError", "DataError"];
      return names.map((errorName) => ({
        errorName,
        message: TRoomPasskeys.userMessage(new DOMException("Browser English error", errorName), {
          operation: "registration", registration: "primary-admin"
        })
      })).concat({
        errorName: "TypeError",
        message: TRoomPasskeys.userMessage(new TypeError("Browser English type error"), { operation: "authentication" })
      });
    });
    for (const result of localizedErrors) {
      assert.match(result.message, /[ぁ-んァ-ヶ一-龠]/, `${name}: ${result.errorName} has a Japanese user message`);
      assert.doesNotMatch(result.message, /Browser English|Error\b/, `${name}: ${result.errorName} does not expose technical text`);
    }
    assert.equal(await page.evaluate(() => TRoomPasskeys.safeJapaneseMessage("一時的なT-Cloud障害", "代替メッセージ")), "一時的なT-Cloud障害",
      `${name}: an existing safe Japanese API error remains unchanged`);
    const sanitizedApiError = await page.evaluate(async () => {
      try { await TRoomPasskeys.api("/test-english-error", {}); }
      catch (error) { return error.message; }
      return "";
    });
    assert.equal(sanitizedApiError, "端末のロック解除を確認できませんでした。", `${name}: an English API error uses a Japanese fallback`);

    setupStatusBody = { active: false };
    securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
    const primaryDuplicate = await context.newPage();
    await primaryDuplicate.goto(`${origin}/security/?scenario=bootstrap-duplicate`, { waitUntil: "load" });
    await primaryDuplicate.locator("#bootstrap-id").fill("admin");
    await primaryDuplicate.locator("#bootstrap-password").fill(dummyPassword);
    await primaryDuplicate.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await primaryDuplicate.locator("#message").waitFor();
    const primaryDuplicateMessage = await primaryDuplicate.locator("#message").textContent();
    assert.equal(primaryDuplicateMessage,
      "この端末またはパスワード管理サービスには、第一管理者のパスキーが既に登録されています。復旧登録ではなく、登録済みのパスキーでログインしてください。",
      `${name}: primary administrator duplicate registration has dedicated guidance`);
    assert.doesNotMatch(primaryDuplicateMessage, /The user attempted|InvalidStateError|relying party/i);
    await primaryDuplicate.close();

    setupStatusBody = { active: false };
    const inviteDuplicate = await context.newPage();
    await inviteDuplicate.goto(`${origin}/security/?scenario=invite-duplicate#invite=test-token`, { waitUntil: "load" });
    await inviteDuplicate.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await inviteDuplicate.locator("#message").waitFor();
    const inviteDuplicateMessage = await inviteDuplicate.locator("#message").textContent();
    assert.equal(inviteDuplicateMessage,
      "この端末またはパスワード管理サービスには、このユーザーのパスキーが既に登録されています。新しく登録せず、管理者に現在の登録状態を確認してください。",
      `${name}: invited user duplicate registration has dedicated guidance`);
    assert.doesNotMatch(inviteDuplicateMessage, /The user attempted|InvalidStateError|relying party/i);
    await inviteDuplicate.close();
    setupStatusBody = {
      active: false, resumable: true, needsTCloudSetup: true, identityId: "resume_user", credentialId: "cmVzdW1lLWNyZWRlbnRpYWw",
      isPrimaryAdmin: false, prfEnabled: true, tcloudReady: false,
      cloudLinks: [{ id: "cloud-2", accountId: "folder-member", rootFolderId: 2 }, { id: "cloud-10", accountId: "folder-member", rootFolderId: 10 }]
    };
    const resumed = await context.newPage();
    await resumed.goto(`${origin}/security/?scenario=general-retry`, { waitUntil: "load" });
    const resumeButton = resumed.getByRole("button", { name: "T-Cloudの準備を再開" });
    await resumeButton.waitFor();
    assert.equal(await resumed.locator("#invite-view").isVisible(), true, `${name}: setup session resumes after reload`);
    await resumeButton.click();
    await resumed.waitForFunction(() => window.__troomWebAuthnGetCalled === true, null, { timeout: 30000 });
    assert.notEqual(await resumed.evaluate(() => window.__troomWebAuthnCreateCalled), true,
      `${name}: lost general setup authority resumes with get(), never create()`);
    await resumed.close();
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
    assert.match(await unsupported.locator("#tcloud-setup-status").textContent(), /この端末ではT-Cloudのパスキー利用に対応していません/);
    assert.equal(await unsupported.locator("#tcloud-setup-resume").isVisible(), false, `${name}: PRF unsupported must not promise a retry`);
    assert.match(await unsupported.locator("#message").textContent(), /セキュリティセンター・日記・請求書のパスキー登録は完了しました/);
    assert.equal(registeredCredentialCount, 1);
    await unsupported.reload({ waitUntil: "load" });
    await unsupported.locator("#dashboard-panel .stats").waitFor();
    assert.equal(await unsupported.locator("#tcloud-setup-notice").isVisible(), true, `${name}: warning survives reload without blocking admin UI`);
    assert.equal(registeredCredentialCount, 1, `${name}: reload must not create a second credential`);
    await unsupported.getByRole("button", { name: "履歴", exact: true }).click();
    await unsupported.locator("#audit-list .audit-row").first().waitFor();
    const auditText = await unsupported.locator("#audit-list").textContent();
    assert.match(auditText, /パスキーでログイン成功/, `${name}: known audit event is shown in Japanese`);
    assert.match(auditText, /パスキーの本人確認に成功/, `${name}: intermediate WebAuthn success is distinct from a completed login`);
    assert.doesNotMatch(auditText, /passkey_login_success/, `${name}: known internal event name is not the primary display`);
    assert.doesNotMatch(auditText, /passkey_authentication_success/, `${name}: intermediate internal event name is not the primary display`);
    assert.match(auditText, /Security Center/);
    assert.match(auditText, /第一管理者/);
    assert.match(auditText, /ユーザーID: primary-admin/, `${name}: technical identity ID is subordinate detail text`);
    assert.equal(await unsupported.locator("#audit-list details.technical-detail:not([open])").count() >= 1, true,
      `${name}: internal IDs stay inside collapsed technical details`);
    assert.match(auditText, /パスキー/);
    assert.match(auditText, /成功/);
    assert.match(auditText, /Windows \/ Edge 151/, `${name}: full User-Agent is summarized`);
    assert.match(auditText, /保存済みセッションでアクセス/, `${name}: session reuse is distinct from a new login`);
    assert.match(auditText, /日記 \/ 田中宏知（一般ユーザー）/, `${name}: audit uses the provider-resolved human account label`);
    assert.match(auditText, /未定義の操作（new_event_/, `${name}: unknown events use an explicit fallback`);
    assert.equal(await unsupported.locator("#xss-marker").count(), 0, `${name}: arbitrary audit strings remain HTML escaped`);
    assert.equal(await unsupported.locator("#audit-event option[value='passkey_registration']").textContent(), "パスキーを登録");
    const moreButton = unsupported.getByRole("button", { name: "もっと見る" });
    assert.equal(await moreButton.isVisible(), true, `${name}: audit next page is offered only when a cursor exists`);
    await moreButton.click();
    await unsupported.waitForFunction(() => document.querySelectorAll("#audit-list .audit-row").length === 5);
    assert.equal(await unsupported.locator("#audit-list .audit-row").count(), 5, `${name}: next audit page appends below the current rows`);
    assert.equal(await moreButton.isVisible(), false, `${name}: audit button hides on the final page`);
    assert.match(receivedAuditQueries.at(-1), /cursor=browser-page-2/, `${name}: the opaque audit cursor is sent for the next page`);
    await unsupported.locator("#audit-event").selectOption("passkey_registration");
    await unsupported.getByRole("button", { name: "履歴を絞り込む" }).click();
    assert.match(receivedAuditQueries.at(-1), /eventType=passkey_registration/, `${name}: Japanese filter preserves canonical API value`);
    assert.doesNotMatch(receivedAuditQueries.at(-1), /cursor=/, `${name}: changing filters resets the prior cursor`);
    assert.equal(await unsupported.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: desktop layout has no horizontal overflow`);
    await unsupported.setViewportSize({ width: 390, height: 844 });
    assert.equal(await unsupported.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: mobile layout has no horizontal overflow`);
    await unsupported.getByRole("button", { name: "ユーザー" }).click();
    assert.match(await unsupported.locator("#users-panel").textContent(), /ユーザーを招待/);
    assert.doesNotMatch(await unsupported.locator("#users-panel").textContent(), /Identity/);
    assert.equal(await unsupported.locator("#invite-name").count(), 1, `${name}: invite UI asks for the human display name`);
    assert.equal(await unsupported.locator("#invite-form input:not(#invite-name):not([type='datetime-local'])").count(), 0,
      `${name}: invite UI has no free-form internal identifier fields`);
    const inviteService = unsupported.locator("#link-rows [data-link-service]").first();
    const inviteTarget = unsupported.locator("#link-rows [data-link-target]").first();
    assert.deepEqual(await inviteService.locator("option").allTextContents(), ["サービスを選択", "日記", "請求書", "T-Cloud"]);
    await inviteService.selectOption("diary");
    assert.deepEqual(await inviteTarget.locator("option").allTextContents(), ["連携先を選択", "田中宏知（一般ユーザー） / 一般ユーザー"]);
    assert.equal(await unsupported.locator("#link-rows .link-target-hint").first().isVisible(), false,
      `${name}: the top-folder explanation is hidden for non-Cloud services`);
    await inviteService.selectOption("cloud");
    assert.deepEqual(await inviteTarget.locator("option").allTextContents(),
      ["連携先を選択", "家族写真 / フォルダ利用者", "動画 / フォルダ利用者"]);
    assert.equal(await unsupported.locator("#link-rows .link-target-hint").first().isVisible(), true,
      `${name}: Cloud selection explains that a top folder includes all descendants`);
    assert.match(await unsupported.locator("#link-rows .link-target-hint").first().textContent(),
      /本人のパスキー.*配下をすべて.*他のT-Cloudフォルダは表示されません/);
    assert.doesNotMatch(await unsupported.locator("#invite-form").textContent(), /main-user|folder-member|フォルダID/,
      `${name}: internal account and numeric folder identifiers are not shown`);
    const cancelledUserRow = unsupported.locator("#identity-list .identity-row").filter({ hasText: "取消テストユーザー" });
    assert.equal(await cancelledUserRow.count(), 1, `${name}: an active invitation is visible before revocation`);
    await cancelledUserRow.getByRole("button", { name: "詳細" }).click();
    await unsupported.locator("#identity-detail [data-revoke-invitation='cancelled-invitation']").waitFor();
    unsupported.once("dialog", (dialog) => dialog.accept());
    await unsupported.locator("#identity-detail [data-revoke-invitation='cancelled-invitation']").click();
    await unsupported.waitForFunction(() => document.querySelector("#message")?.textContent?.includes("未登録のユーザーを一覧から削除しました"));
    assert.equal(await unsupported.locator("#identity-detail").isVisible(), false, `${name}: retired Identity detail closes after revocation`);
    assert.equal(await unsupported.locator("#identity-list").getByText("取消テストユーザー").count(), 0,
      `${name}: the retired unregistered Identity disappears from the user list`);
    assert.match(await unsupported.locator("#message").textContent(), /招待を取り消しました。未登録のユーザーを一覧から削除しました。/);
    const queryCountBeforeRefresh = receivedAuditQueries.length;
    await unsupported.getByRole("button", { name: "履歴", exact: true }).click();
    await unsupported.waitForTimeout(100);
    assert.ok(receivedAuditQueries.length >= queryCountBeforeRefresh + 1, `${name}: opening history fetches current events`);
    const queryCountAfterTab = receivedAuditQueries.length;
    await unsupported.getByRole("button", { name: "最新に更新" }).click();
    await unsupported.waitForTimeout(100);
    assert.ok(receivedAuditQueries.length >= queryCountAfterTab + 1, `${name}: refresh button fetches current events again`);

    setupStatusBody = { active: false };
    securityStatusBody = { enabled: true, initialized: false, adminAuthenticated: false };
    registeredCredentialCount = 0;
    const temporaryPrf = await context.newPage();
    await temporaryPrf.goto(`${origin}/security/?scenario=bootstrap-prf-temporary-missing`, { waitUntil: "load" });
    await temporaryPrf.locator("#bootstrap-id").fill("admin");
    await temporaryPrf.locator("#bootstrap-password").fill(dummyPassword);
    await temporaryPrf.getByRole("button", { name: "端末のロック解除を登録" }).click();
    await temporaryPrf.locator("#dashboard-panel .stats").waitFor({ timeout: 30000 });
    assert.equal(await temporaryPrf.locator("#admin-view").isVisible(), true, `${name}: a temporary PRF result miss does not block Security Center`);
    assert.equal(await temporaryPrf.locator("#tcloud-setup-resume").isVisible(), true,
      `${name}: registration-time PRF capability remains enabled after one missing assertion result`);
    assert.match(await temporaryPrf.locator("#message").textContent(), /一時的に完了できませんでした/);
    assert.doesNotMatch(await temporaryPrf.locator("#tcloud-setup-status").textContent(), /この端末では.*対応していません/);
    assert.equal(registeredCredentialCount, 1);

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

    setupStatusBody = { ...setupStatusBody, active: false, resumable: true, needsTCloudSetup: true };
    await transient.goto(`${origin}/security/?scenario=primary-retry`, { waitUntil: "load" });
    await transient.locator("#dashboard-panel .stats").waitFor();
    assert.equal(await transient.locator("#admin-view").isVisible(), true, `${name}: transient setup reload opens the normal admin UI`);
    await transient.locator("#tcloud-setup-resume").click();
    await transient.locator("#tcloud-setup-id").fill("admin");
    await transient.locator("#tcloud-setup-password").fill(dummyPassword);
    failEnvelopeSave = false;
    await transient.getByRole("button", { name: "同じパスキーでT-Cloudの準備を再開" }).click();
    try {
      await transient.waitForFunction(() => window.__troomWebAuthnGetCalled === true, null, { timeout: 30000 });
    } catch (error) {
      throw new Error(`${error.message}; message=${await transient.locator("#message").textContent()}; setup=${JSON.stringify(setupStatusBody)}`);
    }
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
  receivedSetupResumeBodies.length = 0;
  results.push(await verifyBrowser(chromium, "chromium", origin));
  results.push(await verifyBrowser(firefox, "firefox", origin));
  const passedBrowsers = results.filter((result) => result.endsWith(": pass")).length;
  assert.equal(receivedBootstrapBodies.length, passedBrowsers * 5,
    "each browser includes the duplicate-registration recovery attempt");
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
  assert.equal(receivedSetupResumeBodies.length, passedBrowsers * 2, "lost general and primary setup cookies are resumed explicitly");
  for (const body of receivedSetupResumeBodies) assert.deepEqual(body, {}, "setup resume never trusts a client credential ID");
  assert.equal(receivedEnvelopeBodies.length, passedBrowsers * 2,
    "each browser performs one failed and one successful primary-admin envelope request");
  console.log(results.join("\n"));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
