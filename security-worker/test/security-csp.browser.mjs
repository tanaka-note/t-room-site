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
let setupStatusBody = { active: false };

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
  if (url.pathname === "/security/api/status") return sendJson(response, 200, { enabled: true, initialized: false, adminAuthenticated: false });
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
  if (url.pathname === "/security/api/setup/primary-admin/verify-password") {
    const body = JSON.parse(await readBody(request));
    receivedResumeBodies.push(body);
    return sendJson(response, 200, { verified: true });
  }
  if (url.pathname === "/security/api/prf/options") {
    return sendJson(response, 200, {
      challengeId: "resume-prf-challenge",
      credentialId: "resume-credential",
      prfSalt: "AAECAwQFBgcICQoLDA0ODw",
      options: {
        challenge: "AAECAwQFBgcICQoLDA0ODw",
        rpId: "127.0.0.1",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: "cmVzdW1lLWNyZWRlbnRpYWw" }],
        extensions: { prf: { evalByCredential: { "resume-credential": { first: "AAECAwQFBgcICQoLDA0ODw" } } } }
      }
    });
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
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const credentials = navigator.credentials;
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
          get: async () => {
            window.__troomWebAuthnGetCalled = true;
            throw new DOMException("CSP regression test reached resumed WebAuthn", "NotAllowedError");
          },
          create: async () => {
            window.__troomWebAuthnCreateCalled = true;
            throw new DOMException("CSP regression test reached WebAuthn", "NotAllowedError");
          }
        }
      });
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(`${origin}/security/`, { waitUntil: "load" });
    await page.getByLabel("管理者ID").fill("admin");
    await page.getByLabel("現在の管理者PW").fill(dummyPassword);
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
      active: true, identityId: "resume_user", credentialId: "resume-credential",
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
    setupStatusBody = {
      active: true, identityId: "primary-admin", credentialId: "resume-credential",
      isPrimaryAdmin: true, prfEnabled: true, tcloudReady: false,
      cloudLinks: [{ id: "primary-cloud", accountId: "admin", rootFolderId: null }]
    };
    const primaryResume = await context.newPage();
    await primaryResume.goto(`${origin}/security/`, { waitUntil: "load" });
    await primaryResume.getByLabel("管理者ID").fill("admin");
    await primaryResume.getByLabel("現在の管理者PW").fill(dummyPassword);
    const primaryResumeButton = primaryResume.getByRole("button", { name: "同じパスキーでT-Cloudの準備を再開" });
    await primaryResumeButton.click();
    await primaryResume.waitForFunction(() => window.__troomWebAuthnGetCalled === true, null, { timeout: 30000 });
    assert.notEqual(await primaryResume.evaluate(() => window.__troomWebAuthnCreateCalled), true,
      `${name}: primary-admin setup resume must not create a second credential`);
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
  results.push(await verifyBrowser(chromium, "chromium", origin));
  results.push(await verifyBrowser(firefox, "firefox", origin));
  assert.equal(receivedBootstrapBodies.length, results.filter((result) => result.endsWith(": pass")).length);
  for (const body of receivedBootstrapBodies) {
    assert.equal(body.loginId, "admin");
    assert.match(body.authProof, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!Object.hasOwn(body, "password"), "生PWをSecurity Workerへ送信しません");
    assert.ok(!JSON.stringify(body).includes(dummyPassword), "生PWをリクエスト本文へ含めません");
  }
  assert.equal(receivedResumeBodies.length, results.filter((result) => result.endsWith(": pass")).length);
  for (const body of receivedResumeBodies) {
    assert.equal(body.loginId, "admin");
    assert.match(body.authProof, /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(!Object.hasOwn(body, "password"), "resume sends authProof, never the raw password");
    assert.ok(!JSON.stringify(body).includes(dummyPassword), "resume request never contains the raw password");
  }
  console.log(results.join("\n"));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
