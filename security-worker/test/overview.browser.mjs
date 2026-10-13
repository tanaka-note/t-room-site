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
  // A slow candidate provider must not delay overview or identity rendering.
  const slowServices = await newPage();
  let releaseServices, serviceRequests = 0;
  const serviceGate = new Promise((resolve) => { releaseServices = resolve; });
  await slowServices.route("**/security/api/services", async (route) => {
    serviceRequests++; await serviceGate; await fulfill(route, services);
  });
  try {
    await slowServices.goto(url); await ready(slowServices); await usersReady(slowServices);
    assert.equal(serviceRequests, 1);
    assert.equal(await slowServices.locator("#link-rows .link-row").count(), 0);
    await slowServices.getByRole("button", { name: "ユーザー", exact: true }).click();
    assert.equal(serviceRequests, 1, "parallel readers share the same candidate request");
    releaseServices();
    await slowServices.waitForFunction(() => document.querySelectorAll("#link-rows .link-row").length === 1);
  } finally { releaseServices(); await slowServices.close(); }

  const failedServices = await newPage();
  await failedServices.route("**/security/api/services", (route) => fulfill(route, { error: "日記の連携候補を取得できません。" }, 503));
  await failedServices.goto(url); await ready(failedServices); await usersReady(failedServices);
  assert.match(await failedServices.locator("#dashboard-panel").innerText(), /現在ログイン中のユーザー[\s\S]*確認ユーザー/);
  await failedServices.waitForFunction(() => document.querySelector("#message").textContent.includes("連携候補"));
  await failedServices.close();

  const slowDashboard = await newPage();
  let releaseDashboard;
  const dashboardGate = new Promise((resolve) => { releaseDashboard = resolve; });
  await slowDashboard.route("**/security/api/dashboard", async (route) => { await dashboardGate; await fulfill(route, dashboard); });
  try {
    await slowDashboard.goto(url); await usersReady(slowDashboard);
    assert.equal(await slowDashboard.locator("#dashboard-panel").getAttribute("aria-busy"), "true");
    assert.match(await slowDashboard.locator("#dashboard-panel [role=status]").innerText(), /読み込んでいます/);
    releaseDashboard(); await ready(slowDashboard);
  } finally { releaseDashboard(); await slowDashboard.close(); }

  // Retry both through the explicit button and by returning to the overview tab.
  for (const retry of ["button", "tab"]) {
    const page = await newPage(); let requests = 0;
    await page.route("**/security/api/dashboard", (route) => ++requests === 1
      ? fulfill(route, { error: "概要を一時的に確認できません。<img id=xss-marker src=x>" }, 503)
      : fulfill(route, dashboard));
    await page.goto(url); await page.locator("#dashboard-retry").waitFor(); await usersReady(page);
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
  assert.deepEqual(errors, []);
  console.log("Security overview browser regressions passed (independent reads, loading, failures, retries, invalid JSON, deadline).");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
