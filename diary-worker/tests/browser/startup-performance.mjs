import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Synthetic local latency only; no production credentials, telemetry or WebAuthn timing.
const root = process.env.TROOM_STARTUP_ROOT || fileURLToPath(new URL("../../../", import.meta.url));
const session = { authenticated: true, role: "user", accountName: "fixture", householdId: "fixture-household",
  activeHouseholdId: "fixture-household", canManageEntries: false, canViewTrash: false,
  canPermanentlyDelete: false, canViewInvestment: false, isGlobalOwner: false };
const meta = { months: [], tags: [], draftCount: 0 };
const entries = { entries: [{ id: 1, entryDate: "2026-10-16", title: "起動確認", content: "fixture", tags: [] }], hasMore: false };
const households = { households: [{ id: session.householdId, name: "fixture" }], activeHouseholdId: session.householdId };
const delay = ms => new Promise(done => setTimeout(done, ms));
let requests = [], holdBootstrap = false, releaseBootstrap, wrongHousehold = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  requests.push(url.pathname + url.search);
  const json = (body, headers = {}) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
  if (url.pathname.includes("/api/")) {
    await delay(/\/(bootstrap|meta|entries|households)$/.test(url.pathname) ? 250 : 80);
    if (url.pathname.endsWith("/bootstrap")) {
      if (holdBootstrap) await new Promise(done => { releaseBootstrap = done; });
      return json({ session: wrongHousehold ? { ...session, activeHouseholdId: "other-household" } : session, households, meta, entries: url.searchParams.get("q") ? { ...entries, entries: entries.entries.map(entry => ({ ...entry, title: "検索の結果" })) } : entries });
    }
    if (url.pathname.endsWith("/session")) return json(req.headers.cookie?.includes("fixture=1") ? session : { authenticated: false });
    if (url.pathname.endsWith("/passkey/handoff")) return json(session, { "Set-Cookie": "fixture=1; Path=/; HttpOnly; SameSite=Strict" });
    if (url.pathname.endsWith("/logout")) return json({}, { "Set-Cookie": "fixture=; Path=/; Max-Age=0" });
    if (url.pathname.endsWith("/meta")) return json(meta);
    if (url.pathname.endsWith("/entries")) return json(url.searchParams.get("q") ? { ...entries, entries: entries.entries.map(entry => ({ ...entry, title: "検索の結果" })) } : entries);
    if (url.pathname.endsWith("/households")) return json(households);
    return json({});
  }
  try {
    await delay(30);
    const prefix = ["/diary/", "/security/", "/assets/"].find(p => url.pathname.startsWith(p));
    if (!prefix) throw Error("Unknown path");
    const base = resolve(root, prefix === "/assets/" ? "assets" : `${prefix.slice(1, -1)}-worker/public`);
    const path = resolve(base, url.pathname.slice(prefix.length) || "index.html");
    if (!path.startsWith(base + sep)) throw Error("Invalid path");
    let body = await readFile(path);
    if (url.pathname === "/security/passkey-client.js") body = Buffer.concat([body, Buffer.from(`
      window.TRoomPasskeys = { ...TRoomPasskeys, authenticate: async () => {
        if (window.fixtureAuthGate) await new Promise(done => { window.releaseFixtureAuth = done; });
        for (const path of ["options", "verify", "handoff"]) await fetch("/security/api/auth/" + path, {method:"POST"});
        return {handoff:{handoffToken:"synthetic-fixture"}};
      }};`)]);
    res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" })[extname(path)] || "application/octet-stream",
      "Cache-Control": extname(path) === ".html" ? "no-store" : url.pathname.endsWith("service-worker.js") ? "no-cache" : "public, max-age=3600" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.TROOM_CHROMIUM_EXECUTABLE || [chromium.executablePath(), "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];
try {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const capture = () => {
      const mark = name => { if (!performance.getEntriesByName(name).length) performance.mark(name); };
      if (document.querySelector("#login-view")?.hidden === false && !document.querySelector("#passkey-login")?.disabled) mark("login-ready");
      if (document.querySelector("#app-view")?.hidden === false) {
        mark("app-shell");
        if (!document.querySelector("#app-view").inert) mark("app-interactive");
        for (const id of ["new-entry-button", "draft-button", "trash-button", "investment-section", "household-switcher-wrap"]) {
          if (document.querySelector(`#${id}`)?.hidden === false) window.authorizationFlash = id;
        }
        if (document.querySelector("#entry-list")?.textContent.includes("起動確認")) mark("entries-ready");
      }
    };
    document.addEventListener("DOMContentLoaded", () => {
      capture(); new MutationObserver(capture).observe(document.body, { attributes: true, childList: true, subtree: true });
    });
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).endsWith("/passkey/handoff")) performance.mark("handoff-ready");
      return response;
    };
  });
  async function snapshot(name) {
    await page.waitForTimeout(50);
    const result = await page.evaluate(() => ({
      marks: Object.fromEntries(["login-ready", "handoff-ready", "app-shell", "app-interactive", "entries-ready"].map(name => [name, Math.round(performance.getEntriesByName(name)[0]?.startTime || 0)])),
      js: performance.getEntriesByType("resource").filter(r => new URL(r.name).pathname.endsWith(".js")).map(r => ({ path: new URL(r.name).pathname, bytes: r.decodedBodySize, transfer: r.transferSize })),
      flash: window.authorizationFlash
    }));
    assert.equal(result.flash, undefined, "no unauthorized controls may flash");
    const row = { name, ...result, apiRequests: requests.filter(p => p.includes("/api/")), httpRequests: [...requests] };
    results.push(row);
    console.log(JSON.stringify({ name, ...result.marks, jsBytes: result.js.reduce((n, r) => n + r.bytes, 0), jsRequests: result.js.length, apiRequests: row.apiRequests.length, httpRequests: row.httpRequests.length }));
  }
  requests = [];
  await page.goto(`${origin}/diary/`);
  await page.locator("#login-view:not([hidden])").waitFor();
  await snapshot("A cold signed-out");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(400);
  requests = [];
  await page.reload();
  await page.locator("#login-view:not([hidden])").waitFor();
  await snapshot("B warm signed-out");
  requests = [];
  await page.locator("#passkey-login").click();
  await page.waitForFunction(() => document.querySelector("#entry-list")?.textContent.includes("起動確認"));
  await snapshot("C synthetic passkey login");
  requests = [];
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#entry-list")?.textContent.includes("起動確認"));
  await snapshot("D session resume");
  requests = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = query => query === "(display-mode: standalone)" ? { matches: true, addEventListener() {} } : original(query);
  });
  await page.goto(`${origin}/diary/?source=pwa`);
  await page.waitForFunction(() => document.querySelector("#entry-list")?.textContent.includes("起動確認"));
  await snapshot("E standalone PWA fixture");
  assert.deepEqual(errors, []);
  if (!process.env.TROOM_STARTUP_BASELINE) {
    assert.equal(results[0].js.some(r => /diary(?:-(?:search|photo|rich|weather))?\.js/.test(r.path)), false, "signed-out startup must not load the runtime");
    assert.equal(results[3].apiRequests.length, 2, "resume uses session then bootstrap");
    assert.equal(results[2].apiRequests.length, 5, "unchanged four auth round trips plus bootstrap");
    assert.ok(results[2].marks["app-shell"] < results[2].marks["entries-ready"], "show shell before data");
    assert.equal(results[3].js.some(r => /diary-photo-(processing|upload)\.js/.test(r.path)), false, "reading does not load photo posting tools");
    await page.evaluate(() => history.replaceState({ ...history.state, troomDiaryReturnView: {
      version: 2, savedAt: Date.now(), householdId: "fixture-household", routePath: "/diary/",
      query: "検索", entryCount: 1, month: "2026-10", tag: "", favoritePage: false
    } }, "", location.href));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#entry-list").textContent.includes("検索の結果"));
    assert.equal(await page.locator("#diary-search-input").inputValue(), "検索", "restoring filters waits for the search module");
    await page.evaluate(() => history.replaceState({}, "", location.href));
    // A search during startup must retain its own results while metadata completes.
    holdBootstrap = true;
    await page.reload();
    await page.locator("#app-view:not([hidden])").waitFor();
    while (!releaseBootstrap) await delay(20);
    await page.locator("#diary-search-input").fill("検索");
    await page.locator("#diary-search-input").press("Enter");
    await page.waitForFunction(() => document.querySelector("#entry-list").textContent.includes("検索の結果"));
    releaseBootstrap(); releaseBootstrap = null; holdBootstrap = false;
    await page.waitForTimeout(100);
    assert.ok((await page.locator("#entry-list").textContent()).includes("検索の結果"));
    // A late bootstrap must never resurrect a logged-out UI or household data.
    holdBootstrap = true;
    await page.reload();
    await page.locator("#app-view:not([hidden])").waitFor();
    await page.waitForFunction(() => document.querySelector("#entry-list").textContent.includes("読み込んでいます"));
    while (!releaseBootstrap) await delay(20);
    await page.locator("#logout-button").click();
    await page.locator("#login-view:not([hidden])").waitFor();
    releaseBootstrap(); holdBootstrap = false;
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#app-view").isVisible(), false);
    assert.equal(await page.locator("#entry-list").textContent(), "");
    holdBootstrap = true; releaseBootstrap = null;
    await page.locator("#passkey-login").click();
    await page.locator("#app-view:not([hidden])").waitFor();
    while (!releaseBootstrap) await delay(20);
    await page.locator("#logout-button").click();
    await page.locator("#login-view:not([hidden])").waitFor();
    assert.equal(await page.locator("#passkey-login").isEnabled(), true);
    await page.evaluate(() => { window.fixtureAuthGate = true; });
    await page.locator("#passkey-login").click();
    await page.waitForFunction(() => Boolean(window.releaseFixtureAuth));
    releaseBootstrap(); holdBootstrap = false;
    await page.waitForTimeout(100);
    assert.equal(await page.locator("#passkey-login").isDisabled(), true, "old login completion cannot unlock a newer authentication attempt");
    await page.evaluate(() => { window.fixtureAuthGate = false; window.releaseFixtureAuth(); });
    await page.waitForFunction(() => document.querySelector("#entry-list").textContent.includes("起動確認"));
    await page.locator("#logout-button").click();
    await page.locator("#login-view:not([hidden])").waitFor();
    wrongHousehold = true;
    await context.addCookies([{ name: "fixture", value: "1", url: origin }]);
    await page.reload();
    await page.locator("#login-view:not([hidden])").waitFor();
    assert.equal(await page.locator("#app-view").isVisible(), false, "mismatched household response must fail closed");
    assert.equal(await page.locator("#entry-list").textContent(), "");
    assert.deepEqual(errors, []);
  }
  await context.close();
  if (process.env.TROOM_STARTUP_REPORT) {
    const path = resolve(process.env.TROOM_STARTUP_REPORT);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(results, null, 2));
  }
} finally {
  releaseBootstrap?.(); await browser.close(); await new Promise(done => server.close(done));
}
