import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const services = { services: [{ id: "diary", displayName: "日記", targets: [{ service: "diary", accountId: "main-user", displayLabel: "利用者", role: "user" }] }] };
const dashboard = { loginSuccess: 37, activeUsers: [{ identityId: "fixture-user", displayName: "確認ユーザー", services: ["diary"] }] };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const api = {
    "/security/api/setup/status": { active: false },
    "/security/api/status": { enabled: true, initialized: true, adminAuthenticated: true },
    "/security/api/services": services,
    "/security/api/dashboard": dashboard,
    "/security/api/identities": { identities: [{ id: "fixture-user", displayName: "確認ユーザー", status: "active" }], pendingIdentities: [], auditIdentities: [] },
    "/security/api/audit": { events: [], nextCursor: null }
  };
  if (api[url.pathname]) {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify(api[url.pathname]));
  }
  const files = {
    "/security/": ["../public/index.html", "text/html"],
    "/security/health.html": ["../public/health.html", "text/html"],
    "/security/health-redirect.js": ["../public/health-redirect.js", "text/javascript"],
    "/security/health-setup.mjs": ["../public/health-setup.mjs", "text/javascript"],
    "/security/security.js": ["../public/security.js", "text/javascript"],
    "/security/security-display.js": ["../public/security-display.js", "text/javascript"],
    "/security/security.css": ["../public/security.css", "text/css"],
    "/security/passkey-client.js": ["../public/passkey-client.js", "text/javascript"]
  };
  if (files[url.pathname]) {
    const [file, type] = files[url.pathname];
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Content-Security-Policy": SECURITY_CONTENT_SECURITY_POLICY });
    return response.end(await readFile(new URL(file, import.meta.url)));
  }
  response.writeHead(200, { "Content-Type": "text/javascript" }); response.end("");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
const url = `http://127.0.0.1:${server.address().port}/security/`;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ready = (page) => page.waitForFunction(() => document.querySelector("#dashboard-panel").getAttribute("aria-busy") === "false"
  && document.querySelector("#dashboard-panel .stat strong")?.textContent === "37");
const usersReady = (page) => page.waitForFunction(() => document.querySelector("#identity-list").textContent.includes("確認ユーザー"));
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}
try {
  // Initial overview starts no unrelated lists. A slow provider only affects its tab.
  const slowServices = await newPage();
  let releaseServices, serviceRequests = 0, identityRequests = 0, auditRequests = 0;
  const serviceGate = new Promise((resolve) => { releaseServices = resolve; });
  slowServices.on("request", request => {
    if (new URL(request.url()).pathname === "/security/api/identities") identityRequests++;
    if (new URL(request.url()).pathname === "/security/api/audit") auditRequests++;
  });
  await slowServices.route("**/security/api/services", async (route) => {
    serviceRequests++; await serviceGate; await fulfill(route, services);
  });
  try {
    await slowServices.goto(url); await ready(slowServices);
    assert.deepEqual([serviceRequests, identityRequests, auditRequests], [0, 0, 0]);
    assert.equal(await slowServices.locator("#link-rows .link-row").count(), 0);
    await slowServices.getByRole("button", { name: "ユーザー", exact: true }).click();
    await usersReady(slowServices);
    assert.equal(serviceRequests, 1);
    await slowServices.getByRole("button", { name: "概要", exact: true }).click();
    await slowServices.getByRole("button", { name: "ユーザー", exact: true }).click();
    assert.deepEqual([serviceRequests, identityRequests], [1, 1], "tab reentry shares cached or pending reads");
    releaseServices();
    await slowServices.waitForFunction(() => document.querySelectorAll("#link-rows .link-row").length === 1);
  } finally { releaseServices(); await slowServices.close(); }

  const failedServices = await newPage();
  await failedServices.route("**/security/api/services", (route) => fulfill(route, { error: "日記の連携候補を取得できません。" }, 503));
  await failedServices.goto(url); await ready(failedServices);
  assert.match(await failedServices.locator("#dashboard-panel").innerText(), /現在ログイン中のユーザー[\s\S]*確認ユーザー/);
  await failedServices.getByRole("button", { name: "ユーザー", exact: true }).click(); await usersReady(failedServices);
  await failedServices.waitForFunction(() => document.querySelector("#message").textContent.includes("連携候補"));
  await failedServices.close();

  // Audit summaries do not need identities; only opening advanced filters needs choices.
  const slowIdentities = await newPage();
  let releaseIdentities;
  const identityGate = new Promise(resolve => { releaseIdentities = resolve; });
  await slowIdentities.route("**/security/api/identities", async route => {
    await identityGate;
    await fulfill(route, { identities: [{ id: "fixture-user", displayName: "確認ユーザー", status: "active" }], pendingIdentities: [], auditIdentities: [] });
  });
  try {
    await slowIdentities.goto(url); await ready(slowIdentities);
    await slowIdentities.getByRole("button", { name: "履歴", exact: true }).click();
    await slowIdentities.waitForFunction(() => document.querySelector("#audit-status").textContent.includes("0件を表示"));
    assert.equal(await slowIdentities.locator("#audit-list").getAttribute("aria-busy"), "false");
    assert.equal(await slowIdentities.locator("#identity-list").textContent().then(text => text.includes("確認ユーザー")), false);
    await slowIdentities.locator("#audit-search > summary").click();
    releaseIdentities(); await usersReady(slowIdentities);
    await slowIdentities.getByRole("button", { name: "概要", exact: true }).click();
    await slowIdentities.getByRole("button", { name: "履歴", exact: true }).click();
    assert.equal(await slowIdentities.locator("#audit-search").getAttribute("open"), "");
  } finally { releaseIdentities(); await slowIdentities.close(); }
  const failedIdentities = await newPage();
  await failedIdentities.route("**/security/api/identities", route => fulfill(route, { error: "ユーザー一覧を取得できません。" }, 503));
  await failedIdentities.goto(url); await ready(failedIdentities);
  await failedIdentities.getByRole("button", { name: "履歴", exact: true }).click();
  await failedIdentities.waitForFunction(() => document.querySelector("#audit-status").textContent.includes("0件を表示"));
  await failedIdentities.locator("#audit-search > summary").click();
  await failedIdentities.waitForFunction(() => document.querySelector("#message").textContent.includes("ユーザー一覧"));
  assert.equal(await failedIdentities.locator("#audit-list").getAttribute("aria-busy"), "false");
  await failedIdentities.close();

  const slowDashboard = await newPage();
  let releaseDashboard;
  const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
  await slowDashboard.route("**/security/api/dashboard", async (route) => { await dashboardGate; await fulfill(route, dashboard); });
  try {
    await slowDashboard.goto(url);
    await slowDashboard.waitForFunction(() => document.querySelector("#dashboard-panel").getAttribute("aria-busy") === "true");
    assert.equal(await slowDashboard.locator("#dashboard-panel").getAttribute("aria-busy"), "true");
    assert.match(await slowDashboard.locator("#dashboard-panel [role=status]").innerText(), /読み込んでいます/);
    await slowDashboard.getByRole("button", { name: "ユーザー", exact: true }).click(); await usersReady(slowDashboard);
    releaseDashboard(); await ready(slowDashboard);
  } finally { releaseDashboard(); await slowDashboard.close(); }

  // Retry both through the explicit button and by returning to the overview tab.
  for (const retry of ["button", "tab"]) {
    const page = await newPage(); let requests = 0;
    await page.route("**/security/api/dashboard", (route) => ++requests === 1
      ? fulfill(route, { error: "概要を一時的に確認できません。<img id=xss-marker src=x>" }, 503)
      : fulfill(route, dashboard));
    await page.goto(url); await page.locator("#dashboard-retry").waitFor();
    assert.match(await page.locator("#dashboard-panel [role=alert]").innerText(), /読み込めませんでした/);
    assert.equal(await page.locator("#xss-marker").count(), 0);
    if (retry === "button") await page.locator("#dashboard-retry").click();
    else {
      await page.getByRole("button", { name: "ユーザー", exact: true }).click();
      await page.getByRole("button", { name: "概要", exact: true }).click();
    }
    await ready(page); assert.equal(requests, 2); await page.close();
  }

  const malformed = await newPage(); let malformedRequests = 0;
  await malformed.route("**/security/api/dashboard", (route) => ++malformedRequests === 1
    ? route.fulfill({ contentType: "application/json", body: "{" }) : fulfill(route, dashboard));
  await malformed.goto(url); await malformed.locator("#dashboard-retry").waitFor();
  assert.match(await malformed.locator("#dashboard-panel").innerText(), /取得した情報を確認できません/);
  await malformed.locator("#dashboard-retry").click(); await ready(malformed); await malformed.close();

  const timedOut = await newPage(); let timeoutRequests = 0;
  // Accelerate only the read deadline, keeping other browser clocks intact.
  await timedOut.addInitScript(() => {
    const original = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => original(callback, delay === 15000 ? 100 : delay, ...args);
  });
  await timedOut.route("**/security/api/dashboard", (route) => {
    timeoutRequests++;
    if (timeoutRequests > 1) return fulfill(route, dashboard);
    // No response: the actual client's AbortController must end the read.
  });
  await timedOut.goto(url); await timedOut.locator("#dashboard-retry").waitFor();
  assert.match(await timedOut.locator("#dashboard-panel").innerText(), /読み込みに時間がかかっています/);
  assert.equal(await timedOut.locator("#dashboard-panel").getAttribute("aria-busy"), "false");
  await timedOut.locator("#dashboard-retry").click(); await ready(timedOut); await timedOut.close();

  // Health management belongs to the selected user's service link. Self setup is
  // opened explicitly, including from the former standalone URL.
  for (const width of [1280, 390]) {
    const page = await newPage();
    await page.setViewportSize({ width, height: 900 });
    const grants = [], authentications = [];
    let ownReads = 0, prepared = false, granted = false, failGrant = true;
    const healthIdentity = {
      identity: { id: "fixture-user", displayName: "確認ユーザー", status: "active" },
      credentials: [{ credential_id: "health-credential", label: "本人の端末", status: "active" }],
      links: [{ id: "health-link", service: "health", service_account_id: "fixture-account", display_label: "体調管理", status: "active" }],
      invitations: [], sessions: [], approvalCandidates: []
    };
    await page.route("**/security/api/identities/fixture-user", route => fulfill(route, healthIdentity));
    await page.route("**/security/passkey-client.js*", route => route.fulfill({ contentType: "text/javascript", body: `
      window.TRoomPasskeys = { safeJapaneseMessage: text => text, authenticate: async (service, choose, options) => {
        await fetch('/fixture-auth', { method: 'POST', body: JSON.stringify({ service, options }) });
        return { prfOutput: new Uint8Array(32).fill(1) };
      } };
      window.TRoomCrypto = { unlockAdminPrivateKeyWithPasskey: async () => ({}) };
    ` }));
    await page.route("**/fixture-auth", async route => {
      authentications.push(route.request().postDataJSON()); await fulfill(route, {});
    });
    await page.route("**/security/health-crypto.mjs", route => route.fulfill({ contentType: "text/javascript", body: `
      export const createClientVault = async () => ({ iv: 'fixture', ciphertext: 'encrypted', publicKey: {} });
      export const wrapMaster = async () => 'encrypted-grant';
      export const unwrapMaster = async () => new Uint8Array(32);
    ` }));
    await page.route("**/security/api/health/own", route => {
      ownReads++; return fulfill(route, { prepared, ready: granted });
    });
    await page.route("**/security/api/health/vault", route => { prepared = true; return fulfill(route, { ok: true }); });
    await page.route("**/security/api/health/admin", route => fulfill(route, {
      accountId: "fixture-account", config: { recoveryWrappedKey: "encrypted-recovery" }, recoveryPublicKey: {}, adminEnvelope: {},
      members: [
        { identityId: "fixture-user", credentialId: "health-credential", serviceLinkId: "health-link", publicKey: {}, granted },
        { identityId: "another-user", credentialId: "another-credential", serviceLinkId: "another-link", publicKey: {}, granted: false }
      ]
    }));
    await page.route("**/security/api/health/grant", route => {
      grants.push(route.request().postDataJSON());
      if (failGrant) { failGrant = false; return fulfill(route, { error: "もう一度パスキーで本人確認してください。" }, 401); }
      granted = true; return fulfill(route, { ok: true });
    });
    await page.goto(url); await ready(page);
    assert.equal(await page.locator('a[href="/security/health.html"], main > p a[href="/health/"]').count(), 0);
    assert.equal(await page.locator("#health-setup-notice").isVisible(), false);
    assert.equal(ownReads, 0);
    await page.getByRole("button", { name: "ユーザー", exact: true }).click(); await usersReady(page);
    await page.locator('[data-view-identity="fixture-user"]').click();
    await page.locator("[data-health-manage]").waitFor();
    assert.equal(ownReads, 0, "viewing identity details does not start key operations");
    await page.locator("[data-health-manage]").click();
    const approve = page.getByRole("button", { name: "このパスキーの鍵を承認" });
    await approve.waitFor();
    assert.equal(await approve.count(), 1, "another identity is never included");
    assert.equal(grants.length, 0);
    await approve.click();
    await page.waitForFunction(() => document.querySelector("#message").textContent.includes("もう一度パスキー"));
    await approve.click();
    await page.waitForFunction(() => document.querySelector("[data-health-members]").textContent.includes("本人の端末：承認済み"));
    assert.deepEqual(grants[1], { credentialId: "health-credential", serviceLinkId: "health-link", wrappedKey: "encrypted-grant" });
    assert.deepEqual(authentications.map(auth => auth.service), ["security", "security", "security"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(new URL("health.html", url).href);
    await page.waitForURL("**/security/#health-setup");
    await page.locator("#health-setup-prepare").waitFor();
    assert.equal(await page.locator("#admin-view").isVisible(), false);
    const readsBefore = ownReads;
    await page.locator("#health-setup-prepare").click();
    await page.waitForFunction(() => document.querySelector("#health-setup-status").textContent.includes("利用準備は完了"));
    assert.equal(ownReads, readsBefore + 2);
    assert.deepEqual(authentications.at(-1), { service: "health", options: { handoff: false } });
    assert.equal(grants.length, 2, "self setup never delegates a key");
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("Security overview browser regressions passed (lazy reads, retries, Health user-detail approvals and self setup on desktop/mobile).");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
