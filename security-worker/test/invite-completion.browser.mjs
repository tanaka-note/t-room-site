import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium } = require("playwright");
const title = "パスキーの登録が完了しました。";
const message = "管理者の確認後、利用できるようになります。しばらくお待ちください。";
const credentialId = "Zml4dHVyZS1jcmVkZW50aWFs";
const cloudLinks = [{ id: "fixture-link", accountId: "folder-member", rootFolderId: 2 }];
let setup, scenario, envelopeFails, statusFails, registrations, reads, bodies;
function reset(name = "normal") {
  setup = { active: false, resumable: false };
  scenario = name; envelopeFails = name === "vault-failure"; statusFails = false;
  registrations = 0; reads = 0; bodies = [];
}
const files = new Map([
  ...["index.html", "security.js", "security.css", "security-display.js", "passkey-client.js"].map(name =>
    [name === "index.html" ? "/security/" : `/security/${name}`, new URL(`../public/${name}`, import.meta.url)]),
  ["/cloud/crypto-vault.js", new URL("../../cloud-worker/public/crypto-vault.js", import.meta.url)],
  ["/cloud/vendor/argon2.umd.min.js", new URL("../../cloud-worker/public/vendor/argon2.umd.min.js", import.meta.url)]
]);
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const json = (body, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  if (path.startsWith("/security/api/")) {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body) bodies.push(JSON.parse(body));
    if (path.endsWith("/setup/status")) { reads++; return json(statusFails ? { error: "状態を確認できません。" } : setup, statusFails ? 503 : 200); }
    if (path.endsWith("/status")) return json({ enabled: true, initialized: true, adminAuthenticated: false });
    if (path.endsWith("/invite/options")) return json({ challengeId: "fixture", cloudLinks: scenario === "no-cloud" ? [] : cloudLinks,
      options: { challenge: "AAECAwQFBgcICQoLDA0ODw", rp: { id: "127.0.0.1", name: "Fixture" },
        user: { id: credentialId, name: "fixture", displayName: "Fixture" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }] } });
    if (path.endsWith("/invite/verify")) {
      registrations++;
      setup = { active: true, completed: false, resumable: false, identityId: "fixture", credentialId,
        isPrimaryAdmin: false, credentialStatus: "pending", pendingApproval: true, prfEnabled: !["unsupported", "prf-cancelled"].includes(scenario),
        tcloudReady: scenario === "no-cloud", needsTCloudSetup: scenario !== "no-cloud", clientKeyReady: false,
        cloudLinks: scenario === "no-cloud" ? [] : cloudLinks };
      return json({ ok: true, identityId: "fixture", credentialId, pendingApproval: true, prfEnabled: setup.prfEnabled });
    }
    if (path.endsWith("/prf/options")) return json({ challengeId: "fixture", prfSalt: "AAECAwQFBgcICQoLDA0ODw",
      options: { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "127.0.0.1", allowCredentials: [{ type: "public-key", id: credentialId }],
        extensions: { prf: { eval: { first: "AAECAwQFBgcICQoLDA0ODw" } } } } });
    if (path.endsWith("/prf/verify")) { setup.prfEnabled ||= JSON.parse(body).prfAvailable; return json({ verified: true }); }
    if (path.endsWith("/tcloud/envelope")) {
      if (envelopeFails) return json({ error: "fixture save failure" }, 503);
      setup = { ...setup, active: false, completed: true, tcloudReady: true, needsTCloudSetup: false, clientKeyReady: true };
      return json({ ok: true });
    }
    return json({ error: "unexpected fixture API" }, 404);
  }
  response.setHeader("Content-Security-Policy", SECURITY_CONTENT_SECURITY_POLICY);
  if (path === "/assets/pwa-auto-update.js") { response.setHeader("Content-Type", "text/javascript"); return response.end(""); }
  if (path === "/elsewhere") { response.setHeader("Content-Type", "text/html"); return response.end("<p>Other page</p>"); }
  const file = files.get(path);
  if (!file) { response.writeHead(404); return response.end(); }
  response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
  response.end(await readFile(file));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      const unsupported = new URL(location.href).searchParams.get("scenario") === "unsupported";
      window.fixtureCancelGet = new URL(location.href).searchParams.get("scenario") === "prf-cancelled";
      window.fixtureSteps = [];
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      const credential = registration => ({ id: "Zml4dHVyZS1jcmVkZW50aWFs", rawId: bytes, type: "public-key",
        response: registration ? { clientDataJSON: bytes, attestationObject: bytes, getTransports: () => ["internal"] }
          : { clientDataJSON: bytes, authenticatorData: bytes, signature: bytes },
        getClientExtensionResults: () => ({ prf: unsupported ? {} : registration ? { enabled: !window.fixtureCancelGet } : { results: { first: new Uint8Array(32).fill(17).buffer } } }) });
      Object.defineProperty(navigator, "credentials", { value: {
        create: async () => { window.fixtureSteps.push(["create", document.querySelector("#invite-progress").textContent]); return credential(true); },
        get: async () => { window.fixtureSteps.push(["get", document.querySelector("#invite-progress").textContent]);
          if (window.fixtureCancelGet) throw new DOMException("fixture cancellation", "NotAllowedError");
          return credential(false); }
      } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const visit = async (invitation = true) => page.goto(`${origin}/security/?scenario=${scenario}${invitation ? "#invite=fixture" : ""}`);
    const complete = async () => {
      await page.locator("#invite-complete").waitFor();
      assert.equal(await page.locator("#invite-complete h2").textContent(), title);
      assert.equal(await page.locator("#invite-complete p").textContent(), message);
      assert.equal(await page.locator("#invite-view").isVisible(), false);
      assert.equal(await page.locator("#invite-register").isVisible(), false);
      assert.equal(await page.locator("#message").isVisible(), false);
      assert.equal(await page.locator("#invite-complete a, #invite-complete button").count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    reset(); await visit();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.locator("#invite-register").click(); await complete();
    assert.equal(registrations, 1);
    const steps = await page.evaluate(() => window.fixtureSteps);
    assert.deepEqual(steps.map(s => s[0]), ["create", "get"]);
    assert.match(steps[0][1], /パスキーを登録しています/);
    assert.match(steps[1][1], /続けて端末のロック解除を確認する場合があります/);
    assert.equal(setup.pendingApproval, true);
    assert.equal(setup.active, false); assert.equal(setup.completed, true);
    const envelope = bodies.find(body => body.envelopeType === "client_private_prf");
    assert.ok(envelope.encryptedPayload); assert.ok(envelope.publicKeyJwk);
    assert.doesNotMatch(JSON.stringify(bodies), /prfOutput|privateKey|"results"/);
    await page.reload(); await complete();
    await page.goto(`${origin}/elsewhere`); await page.goBack(); await complete();
    assert.equal(registrations, 1, "reload/back never repeats registration");
    const priorReads = reads;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await complete(); assert.ok(reads > priorReads, "BFCache restoration reads server state");

    // An unavailable or revoked server state must not retain cached success.
    statusFails = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.locator("#message").waitFor();
    assert.equal(await page.locator("#invite-complete").isVisible(), false);
    statusFails = false; setup = { active: false, resumable: false };
    await page.reload(); await page.locator("#admin-login-view").waitFor();
    assert.equal(await page.locator("#invite-complete").isVisible(), false);

    reset("vault-failure"); await visit(); await page.locator("#invite-register").click();
    await page.locator("#message.error").waitFor();
    assert.match(await page.locator("#message").textContent(), /パスキーは登録済み/);
    assert.equal(await page.locator("#invite-complete").isVisible(), false);
    await page.reload(); await page.getByRole("button", { name: "T-Cloudの準備を再開" }).waitFor();
    envelopeFails = false; await page.locator("#invite-register").click(); await complete();
    assert.equal(registrations, 1, "vault retry reuses the same credential");
    assert.deepEqual((await page.evaluate(() => window.fixtureSteps)).map(s => s[0]), ["get"]);

    reset("unsupported"); await visit(); await page.locator("#invite-register").click();
    await page.waitForFunction(() => document.querySelector("#invite-description").textContent.includes("対応していません"));
    assert.equal(await page.locator("#invite-complete").isVisible(), false);
    assert.match(await page.locator("#invite-description").textContent(), /日記・請求書のパスキー登録は完了/);
    assert.equal(bodies.some(body => body.envelopeType), false);
    await page.reload(); await page.locator("#invite-register").waitFor();
    assert.equal(await page.locator("#invite-complete").isVisible(), false);
    assert.equal(registrations, 1);

    reset("prf-cancelled"); await visit(); await page.locator("#invite-register").click();
    await page.locator("#message.error").waitFor();
    assert.equal(await page.locator("#invite-complete").isVisible(), false);
    assert.doesNotMatch(await page.locator("#message").textContent(), /対応していません|PRF/);
    await page.reload(); await page.locator("#invite-register").waitFor();
    await page.evaluate(() => { window.fixtureCancelGet = false; });
    await page.locator("#invite-register").click(); await complete();
    assert.equal(registrations, 1, "cancelled verification retries safely even when support was not yet measured");

    reset("no-cloud"); await visit(); await page.locator("#invite-register").click(); await complete();
    assert.equal(setup.active, true, "no-cloud setup need not have a completed flag");
    await page.reload(); await complete();
    assert.deepEqual(errors, []);
    console.log(`invite completion: registration, reload/back, pending approval, failure/retry, unsupported, no Cloud (${viewport.width}px): ok`);
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
