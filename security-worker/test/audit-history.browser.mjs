import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { auditFixture } from "./audit-history-fixture.mjs";
import { SECURITY_CONTENT_SECURITY_POLICY } from "../src/security-headers.js";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const fixture = auditFixture();
for (let index = 0; index < 103; index++) fixture.add();
fixture.add({ event_type: "session_resume" });
fixture.add({ event_type: "passkey_login_success", auth_method: "passkey" });
fixture.add({ event_type: "passkey_authentication_failure", auth_method: "passkey", outcome: "failure" });
fixture.add({ event_type: "passkey_authentication_options", auth_method: "passkey", outcome: "info" });
fixture.add({ event_type: "login_locked", outcome: "blocked" });
fixture.add({ event_type: "password_login_failure", outcome: "failure", identity_id: null, service_account_id: null, service_account_label: null, role: null });
fixture.add({ event_type: "entry_created", service: "billing", details_json: '{"note":"<img id=xss-marker src=x>"}' });
let delayPassword = false;
let failNext = false;
const queries = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (body, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  if (url.pathname === "/security/api/audit") {
    queries.push(url.search);
    if (delayPassword && url.searchParams.get("view") === "password") await new Promise((resolve) => setTimeout(resolve, 200));
    if (failNext) { failNext = false; return send({ error: "一時的に確認できません" }, 503); }
    return send(await fixture.query(url.search.slice(1)));
  }
  const api = {
    "/security/api/setup/status": { active: false },
    "/security/api/status": { enabled: true, initialized: true, adminAuthenticated: true },
    "/security/api/services": { services: [] },
    "/security/api/dashboard": {},
    "/security/api/identities": { identities: [{ id: "test-user", displayName: "副管理者", status: "active" }], pendingIdentities: [], auditIdentities: [] }
  };
  if (api[url.pathname]) return send(api[url.pathname]);
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
  // Unrelated crypto/update assets are inert in this isolated UI fixture.
  response.writeHead(200, { "Content-Type": "text/javascript" }); response.end("");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/security/`);
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  assert.equal(await page.locator("#users-panel").isVisible(), false);
  assert.equal(await page.locator("#dashboard-panel").isVisible(), false);
  const settle = () => page.waitForFunction(() => document.querySelector("#audit-list").getAttribute("aria-busy") === "false");
  const choose = async (view) => { await page.locator(`[data-audit-view="${view}"]`).click(); await settle(); };
  await settle();
  assert.equal(await page.locator("#audit-search").getAttribute("open"), null);
  await choose("password");
  assert.equal(await page.locator(".audit-row").count(), 100);
  assert.doesNotMatch(await page.locator("#audit-list").innerText(), /保存済みセッション|パスキー認証を開始/);
  const summary = await page.locator(".audit-summary").first().innerText();
  for (const value of ["2026/9/8 22:14", "副管理者", "T-Cloud", "ID・パスワード", "成功", "Windows / Chrome"]) assert.ok(summary.includes(value), value);
  assert.equal(await page.locator(".audit-detail").first().isVisible(), false);
  await page.locator(".audit-summary").first().click();
  assert.match(await page.locator(".audit-detail").first().innerText(), /2026\/9\/8 22:14:00（日本時間）/);
  assert.match(await page.locator(".audit-detail").first().innerText(), /Identity ID[\s\S]*test-user[\s\S]*サービス内ID[\s\S]*subadmin[\s\S]*role[\s\S]*User-Agent/);
  await page.locator("#audit-load-more").click(); await settle();
  assert.equal(await page.locator(".audit-row").count(), 105);
  assert.equal(await page.locator("#audit-load-more").isVisible(), false);
  await choose("passkey");
  assert.equal(await page.locator(".audit-row").count(), 2);
  await choose("attention");
  assert.equal(await page.locator(".audit-row").count(), 3);
  assert.match(await page.locator("#audit-list").innerText(), /ユーザー不明/);
  await page.locator("#audit-search > summary").click();
  await page.locator("#audit-service").selectOption("billing");
  await page.getByRole("button", { name: "履歴を絞り込む" }).click(); await settle();
  assert.equal(await page.locator(".audit-row").count(), 0);
  await page.locator("#audit-search > summary").click();
  assert.match(await page.locator("#audit-search > summary").innerText(), /絞り込み中/);
  await choose("all");
  assert.equal(await page.locator(".audit-row").count(), 1, "preset intersects advanced filter");
  await page.locator(".audit-summary").click();
  assert.equal(await page.locator("#xss-marker").count(), 0);
  assert.match(await page.locator(".audit-detail").innerText(), /<img id=xss-marker/);
  await page.locator("#audit-search > summary").click();
  await page.locator("#audit-filter-clear").click(); await settle();
  await choose("password");
  await page.locator("#audit-service").selectOption("billing");
  await page.locator("#audit-load-more").click(); await settle();
  assert.doesNotMatch(queries.at(-1), /service=billing/, "unsubmitted fields cannot change a cursor page");
  await page.locator("#audit-filter-clear").click(); await settle();
  delayPassword = true;
  const slowResponse = page.waitForResponse((r) => r.url().includes("view=password"));
  await page.locator('[data-audit-view="password"]').click();
  await choose("passkey");
  await slowResponse;
  assert.equal(await page.locator(".audit-row").count(), 2, "stale password response cannot overwrite passkey results");
  delayPassword = false;
  failNext = true;
  await choose("attention");
  assert.match(await page.locator("#audit-status").innerText(), /読み込めませんでした/);
  await page.locator("#audit-refresh").click(); await settle();
  assert.equal(await page.locator(".audit-row").count(), 3);
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no page overflow at ${width}`);
    for (const view of ["all", "password", "passkey", "attention"]) assert.equal(await page.locator(`[data-audit-view="${view}"]`).isVisible(), true);
    const geometry = await page.locator(".audit-summary").first().evaluate((row) => ({ width: row.clientWidth, scroll: row.scrollWidth, columns: getComputedStyle(row).gridTemplateColumns, after: getComputedStyle(row, '::after').gridColumn,
      children: [...row.children].map((child) => ({ text: child.textContent, width: child.clientWidth, scroll: child.scrollWidth })) }));
    if (geometry.scroll > geometry.width) { await page.locator(".audit-summary").first().scrollIntoViewIfNeeded(); await page.screenshot({ path: "../tmp/security-audit-layout.png" }); }
    assert.ok(geometry.scroll <= geometry.width, `row fits ${width}: ${JSON.stringify(geometry)}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await choose("password");
  await page.locator("#audit-search > summary").click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: process.env.AUDIT_SCREENSHOT || "../tmp/security-audit-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: process.env.AUDIT_MOBILE_SCREENSHOT || "../tmp/security-audit-mobile.png" });
  assert.deepEqual(errors, []);
  console.log("Audit UI passed: all presets, details/XSS, filters, paging, races, retry, JST, desktop/mobile and CSP.");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  fixture.close();
}
