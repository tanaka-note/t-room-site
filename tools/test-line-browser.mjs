import { ensureLineBrowserGuard } from "./line-browser-html.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { lineBrowserPolicy } from "../assets/line-browser-policy.mjs";
import { LINE_BROWSER_BOOTSTRAP, LINE_BROWSER_SCRIPT_CSP, LINE_BROWSER_STYLE_CSP } from "../assets/line-browser-csp.mjs";
import { lineBrowserResponse } from "../assets/line-browser-worker.mjs";

const policy = lineBrowserPolicy(null);
export const uas = {
  androidLine: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 Line/15.0.1",
  iphoneLine: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1 Line/15.0.1",
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0",
  safari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  twa: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"
};
test("only the LINE UA token is restricted; ordinary browsers and native clients pass", () => {
  for (const [name, ua] of Object.entries(uas)) assert.equal(policy.isLine(ua), name.endsWith("Line"), name);
  for (const ua of ["", "OkHttp/4.12", "Online/1.2", "Underline/15.0", "LineageOS/20", "Safari/604.1"]) assert.equal(policy.isLine(ua), false);
});
test("running standalone PWA/TWA bypasses the client warning, but source=twa and installed-app hints do not", () => {
  for (const mode of ["standalone", "fullscreen", "minimal-ui"]) {
    const p = lineBrowserPolicy({ navigator: { userAgent: uas.androidLine }, matchMedia: q => ({ matches: q === `(display-mode: ${mode})` }) });
    assert.equal(p.isApp(), true); assert.equal(p.enforce(), false);
  }
  assert.equal(lineBrowserPolicy({ navigator: { standalone: true } }).isApp(), true);
  assert.equal(lineBrowserPolicy({ navigator: { getInstalledRelatedApps: () => [{ id: "installed" }] }, location: { search: "?source=twa" } }).isApp(), false);
});
test("external links preserve path/query/fragment and deduplicate only the LINE control flags", () => {
  const source = "https://tanaka-note.com/diary/deep?tag=a%26b&tag=c&openExternalBrowser=0&openExternalBrowser=1&openInAppBrowser=0#photo-12";
  const url = new URL(policy.externalUrl(source));
  assert.equal(url.pathname, "/diary/deep"); assert.deepEqual(url.searchParams.getAll("tag"), ["a&b", "c"]);
  assert.deepEqual(url.searchParams.getAll("openExternalBrowser"), ["1"]); assert.equal(url.searchParams.has("openInAppBrowser"), false);
  assert.equal(url.hash, "#photo-12"); assert.equal(policy.externalUrl(url.href), url.href);
  assert.equal(new URL(policy.externalUrl("https://tanaka-note.com/?url=https://evil.test")).origin, "https://tanaka-note.com");
  for (const url of ["https://evil.test/", "javascript:alert(1)", "//evil.test", "https://tanaka-note.com.evil.test/", "https://evil@tanaka-note.com/", "https://tanaka-note.com:444/"]) assert.equal(policy.externalUrl(url), null);
});
test("app intents target only existing HTTPS TWA scopes/packages with same-site browser fallback", () => {
  for (const [path, name] of [["diary", "jp.tanaka.troom.diary.twa"], ["cloud", "jp.tanaka.tcloud.twa"]]) {
    const source = `https://tanaka-note.com/${path}/deep?x=1#key;package=evil;end`;
    const intent = policy.appUrl(source, uas.androidLine);
    const [data, block] = [intent.slice(0, intent.lastIndexOf("#Intent;")), intent.slice(intent.lastIndexOf("#Intent;"))];
    assert.equal(data.replace(/^intent:/, "https:"), source); assert.match(block, new RegExp(`;package=${name};`));
    assert.equal(decodeURIComponent(block.match(/S.browser_fallback_url=([^;]+);/)[1]), policy.externalUrl(source));
    assert.equal(policy.appUrl(source, uas.iphoneLine), null);
  }
  for (const path of ["/", "/billing/", "/security/", "/cloud-evil/", "/diary", "/ai/"]) assert.equal(policy.appUrl(`https://tanaka-note.com${path}`, uas.androidLine), null);
});
test("gate uses escaped links, exact CSP hashes and no dismiss/automatic redirect", () => {
  const html = policy.contents('https://tanaka-note.com/diary/?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E', uas.androidLine);
  assert.doesNotMatch(html, /<script>|onclick|window\.location|閉じる|Chromeで|com\.android\.chrome/);
  const hash = text => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
  assert.equal(LINE_BROWSER_BOOTSTRAP, `(${lineBrowserPolicy.toString()})(window).enforce();`.replaceAll("<", "\\u003c"), "regenerate the literal before publishing source changes");
  assert.equal(LINE_BROWSER_SCRIPT_CSP, hash(LINE_BROWSER_BOOTSTRAP)); assert.equal(LINE_BROWSER_STYLE_CSP, hash(policy.css));
  const once = ensureLineBrowserGuard('<!doctype html><html><head><meta charset="utf-8"><script src="app.js"></script></head><body></body></html>');
  assert.equal(ensureLineBrowserGuard(once), once); assert.ok(once.indexOf("data-tlain-browser-guard") < once.indexOf('src="app.js"'));
});
test("LINE responses stop navigation and API access without cookies, redirects or cacheable errors", async () => {
  for (const path of ["/", "/new-page/deep?q=1", "/diary/", "/cloud/share/token", "/billing/", "/security/", "/downloader/", "/ai/api/chat"]) {
    for (const ua of [uas.androidLine, uas.iphoneLine]) {
      const r = lineBrowserResponse(new Request(`https://tanaka-note.com${path}`, { headers: { "User-Agent": ua, Accept: "text/html" } }));
      assert.equal(r.status, 403); assert.match(r.headers.get("Cache-Control"), /no-store/); assert.equal(r.headers.get("Location"), null); assert.equal(r.headers.get("Set-Cookie"), null);
    }
    assert.equal(lineBrowserResponse(new Request(`https://tanaka-note.com${path}`, { headers: { "User-Agent": uas.safari } })), null);
  }
  const api = lineBrowserResponse(new Request("https://tanaka-note.com/security/api/auth/options", { method: "POST", headers: { "User-Agent": uas.androidLine } }));
  assert.equal((await api.json()).code, "unsupported_browser");
  assert.equal(lineBrowserResponse(new Request("https://tanaka-note.com/.well-known/assetlinks.json", { headers: { "User-Agent": uas.androidLine } })), null);
});
test("small-app Service Workers never cache LINE/error/no-store responses, but retain normal offline caching", async () => {
  for (const app of ["calculator", "ima-camera", "kokoro-tenbin", "motivation-switch", "omikuji"]) {
    let handler, response, pending;
    const writes = [];
    const cache = { put: async (request, value) => writes.push([request.url, value.status]) };
    const origin = "https://tanaka-note.com";
    runInNewContext(readFileSync(new URL(`../apps/${app}/sw.js`, import.meta.url), "utf8"), {
      URL, self: { location: { origin }, addEventListener: (name, fn) => { if (name === "fetch") handler = fn; } },
      caches: { open: async () => cache, match: async () => undefined }, fetch: async () => response.clone()
    });
    for (const path of [`/apps/${app}/`, `/apps/${app}/app.js`]) {
      const request = { method: "GET", url: origin + path, mode: path.endsWith("/") ? "navigate" : "cors" };
      for (response of [new Response("blocked", { status: 403, headers: { "X-Tlain-Browser-Policy": "line-blocked", "Cache-Control": "no-store" } }), new Response("private", { headers: { "Cache-Control": "no-store" } })]) {
        handler({ request, respondWith: promise => { pending = promise; } }); await pending;
        await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 0, app);
      }
    }
    response = new Response("normal");
    handler({ request: { method: "GET", url: `${origin}/apps/${app}/`, mode: "navigate" }, respondWith: promise => { pending = promise; } }); await pending;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(writes.length, 1, app);
  }
});

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}; export class DurableObject {}; export const waitUntil=()=>{};", shortCircuit: true };
  if (specifier === "@cloudflare/containers") return { url: "data:text/javascript,export class Container {}; export class ContainerProxy {}; export const getContainer=()=>{throw Error('unexpected container call')};", shortCircuit: true };
  return next(specifier, context);
} });
test("all seven production entrypoints reject LINE before any DB, authentication, assets or container call", async () => {
  const env = new Proxy({}, { get() { throw Error("Application initialization must not start"); } });
  for (const service of ["site", "diary", "billing", "cloud", "security", "downloader", "ai"]) {
    const worker = (await import(service === "site" ? "../site-worker/index.mjs" : `../${service}-worker/src/index.js`)).default;
    for (const method of ["GET", "POST"]) {
      const request = new Request(`https://tanaka-note.com/${service}/api/session`, { method, headers: { "User-Agent": uas.androidLine } });
      const response = typeof worker === "function" ? await worker.prototype.fetch.call({ env, ctx: env }, request) : await worker.fetch(request, env, env);
      assert.equal(response.status, 403, service);
    }
  }
});
test("all tracked HTML uses the shared first script; Android links/brands and passkey code are retained", () => {
  const files = execFileSync("git", ["ls-files", "*.html"], { encoding: "utf8" }).trim().split("\n");
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    if (!/^\s*(?:<!doctype\s+html|<html\b)/i.test(source)) continue;
    assert.match(source.match(/<script\b[^>]*>/i)?.[0] || "", /data-tlain-browser-guard/, path);
    assert.equal(ensureLineBrowserGuard(source), source, path);
  }
  for (const path of [".well-known/assetlinks.json", "android-tcloud-twa/app/src/main/AndroidManifest.xml", "android-diary-twa/app/src/main/AndroidManifest.xml", "assets/passkey-session-validation.mjs", "security-worker/public/passkey-client.js", "assets/password-auth-policy.mjs", "cloud-worker/public/crypto-vault.js"]) {
    assert.equal(execFileSync("git", ["diff", "--", path], { encoding: "utf8" }), "", path);
  }
});
