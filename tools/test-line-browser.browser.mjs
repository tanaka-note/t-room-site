import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureLineBrowserGuard } from "./line-browser-html.mjs";
import { lineBrowserResponse } from "../assets/line-browser-worker.mjs";
import { SECURITY_CONTENT_SECURITY_POLICY } from "../security-worker/src/security-headers.js";
const require = createRequire(new URL("../diary-worker/package.json", import.meta.url));
// WebKit leaves document.fonts.ready pending after window.stop(). The gate uses
// system fonts only; do not wait for that cancelled document load in screenshots.
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
const { chromium, firefox, webkit } = require(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const androidLine = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 Line/15.0.1";
const iphoneLine = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 Line/15.0.1";
const normalUas = ["Mozilla/5.0 Chrome/130.0 Safari/537.36", "Mozilla/5.0 Chrome/130.0 Edg/130.0", "Mozilla/5.0 Version/18.0 Safari/605.1.15", "Mozilla/5.0 Gecko/130.0 Firefox/130.0"];
const files = execFileSync("git", ["ls-files", "*.html"], { encoding: "utf8" }).trim().split("\n");
const representatives = ["index.html", "diary-worker/public/index.html", "cloud-worker/public/index.html", "billing-worker/public/index.html", "security-worker/public/index.html", "downloader-worker/public/index.html", "cloud-worker/public/offline.html"];
mkdirSync(new URL("../tmp/", import.meta.url), { recursive: true });

async function fixture(browser, { ua = normalUas[0], serverGate = false, standalone = false, viewport = { width: 390, height: 844 } } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport });
  if (standalone) await context.addInitScript(() => { const original = window.matchMedia.bind(window); window.matchMedia = q => q === "(display-mode: standalone)" ? { matches: true } : original(q); });
  const state = { html: "", calls: [], errors: [] };
  await context.route("**/*", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    state.calls.push(path);
    if (serverGate) {
      const gate = lineBrowserResponse(new Request(request.url(), { headers: request.headers(), method: request.method() }));
      if (gate) return route.fulfill({ status: gate.status, headers: Object.fromEntries(gate.headers), body: await gate.text() });
    }
    if (path === "/fixture-init.js") return route.fulfill({ contentType: "text/javascript", body: "window.applicationStarted = true; fetch('/fixture-api');" });
    if (path === "/fixture-api") return route.fulfill({ contentType: "application/json", body: "{}" });
    if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "Content-Security-Policy": SECURITY_CONTENT_SECURITY_POLICY }, body: state.html });
    return route.fulfill({ contentType: path.endsWith(".css") ? "text/css" : "text/javascript", body: "" });
  });
  const page = await context.newPage();
  page.on("pageerror", error => state.errors.push(error.message));
  return { context, page, state };
}
let checks = 0;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await engine.launch({ headless: true });
  try {
    // Simulate cached normal HTML: the server gate cannot help in this case.
    const f = await fixture(browser, { ua: androidLine });
    for (const file of name === "chromium" ? files : representatives) {
      f.state.html = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace("</head>", '<script src="/fixture-init.js"></script></head>');
      f.state.calls.length = 0;
      await f.page.goto(`https://tanaka-note.com/diary/deep?q=${encodeURIComponent(file)}&openExternalBrowser=0&openExternalBrowser=1#photo-12`, { waitUntil: "commit" });
      await f.page.locator("#browser-title").waitFor();
      assert.equal(await f.page.evaluate(() => window.applicationStarted), undefined, file);
      assert.equal(f.state.calls.includes("/fixture-api"), false, file);
      assert.equal(await f.page.locator("form, dialog, canvas, video").count(), 0, file);
      const external = new URL(await f.page.locator("#open-browser").getAttribute("href"));
      assert.equal(external.pathname, "/diary/deep"); assert.equal(external.hash, "#photo-12"); assert.deepEqual(external.searchParams.getAll("openExternalBrowser"), ["1"]);
      assert.equal(await f.page.locator("#open-app").count(), 1);
      checks++;
    }
    await f.page.screenshot({ path: new URL(`../tmp/line-${name}-android.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1") });
    await f.page.goto("https://tanaka-note.com/diary/another", { waitUntil: "commit" });
    await f.page.locator("#browser-title").waitFor();
    await f.page.goBack({ waitUntil: "commit" }); await f.page.locator("#browser-title").waitFor();
    assert.equal(await f.page.evaluate(() => window.applicationStarted), undefined);
    await f.context.close();

    for (const ua of normalUas) {
      const normal = await fixture(browser, { ua });
      normal.state.html = ensureLineBrowserGuard('<!doctype html><html><head><meta charset="utf-8"><script src="/fixture-init.js"></script></head><body><h1 id="normal">通常画面</h1></body></html>');
      await normal.page.goto("https://tanaka-note.com/diary/", { waitUntil: "load" });
      assert.equal(await normal.page.evaluate(() => window.applicationStarted), true);
      assert.equal(await normal.page.locator("#browser-title").count(), 0);
      assert.equal(normal.state.calls.filter(path => path === "/fixture-api").length, 1);
      await normal.context.close(); checks++;
    }
    const pwa = await fixture(browser, { ua: androidLine, standalone: true });
    pwa.state.html = ensureLineBrowserGuard('<!doctype html><html><head><meta charset="utf-8"><script src="/fixture-init.js"></script></head><body>Standalone</body></html>');
    await pwa.page.goto("https://tanaka-note.com/diary/?source=twa", { waitUntil: "load" });
    assert.equal(await pwa.page.evaluate(() => window.applicationStarted), true); await pwa.context.close(); checks++;

    for (const ua of [androidLine, iphoneLine]) {
      const blocked = await fixture(browser, { ua, serverGate: true });
      for (const path of ["/", "/diary/", "/cloud/share/token?q=1#fragment", "/billing/", "/security/", "/downloader/", "/new-page/deep?q=x"]) {
        await blocked.page.goto(`https://tanaka-note.com${path}`, { waitUntil: "commit" });
        await blocked.page.locator("#browser-title").waitFor();
        assert.equal(await blocked.page.locator("#open-app").count(), ua === androidLine && /^\/(diary|cloud)\//.test(path) ? 1 : 0);
        assert.equal(await blocked.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(await blocked.page.locator("#open-browser").evaluate(el => el.getBoundingClientRect().height >= 48));
        checks++;
      }
      await blocked.page.emulateMedia({ colorScheme: "dark" });
      await blocked.page.setViewportSize({ width: 320, height: 640 });
      assert.equal(await blocked.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await blocked.page.screenshot({ path: new URL(`../tmp/line-${name}-${ua === iphoneLine ? "iphone" : "android"}-dark.png`, import.meta.url).pathname.replace(/^\/(\w:)/, "$1") });
      assert.deepEqual(blocked.state.errors, []);
      await blocked.context.close();
    }
    console.log(`${name}: cached entrypoints, normal browsers, standalone, network gate, back navigation, mobile/dark layout passed`);
  } finally { await browser.close(); }
}
console.log(`LINE browser checks passed: ${checks}`);
