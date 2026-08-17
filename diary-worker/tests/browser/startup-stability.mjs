import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox } = require("playwright");
const publicRoot = resolve(fileURLToPath(new URL("../../public/", import.meta.url)));
const workspace = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const updaterPath = resolve(workspace, "assets/pwa-auto-update.js");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    const waits = { "/session": 40, "/households": 120, "/meta": 160, "/entries": 200 };
    await delay(waits[apiPath] || 0);
    const body = apiPath === "/session"
      ? {
          authenticated: true,
          role: "admin",
          accountName: "起動テスト",
          householdId: "main-household",
          activeHouseholdId: "main-household",
          isGlobalOwner: true,
          canManageEntries: true,
          canViewTrash: true,
          canPermanentlyDelete: true,
          canViewInvestment: false
        }
      : apiPath === "/households"
        ? { activeHouseholdId: "main-household", households: [{ id: "main-household", name: "日記" }] }
        : apiPath === "/meta"
          ? { draftCount: 0, months: [{ month: "2026-08", count: 1 }], tags: [{ tag: "確認", count: 1 }] }
          : apiPath === "/entries"
            ? {
                entries: [{
                  id: 1,
                  entryDate: "2026-08-18",
                  title: "起動確認",
                  body: "安定した初期表示",
                  authorName: "起動テスト",
                  tags: ["確認"],
                  photos: []
                }],
                hasMore: false
              }
            : {};
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
    return;
  }

  if (url.pathname === "/assets/pwa-auto-update.js") {
    response.writeHead(200, { "content-type": contentTypes[".js"], "cache-control": "no-store" });
    response.end(await readFile(updaterPath));
    return;
  }

  const relativePath = url.pathname === "/diary/" ? "index.html" : url.pathname.replace(/^\/diary\//, "");
  const target = resolve(publicRoot, relativePath);
  if (target === publicRoot || (!target.startsWith(`${publicRoot}${sep}`) && target !== publicRoot)) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": contentTypes[extname(target)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

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

async function verifyStartup(browserType, name) {
  const executablePath = browserExecutable(name);
  if (!executablePath) return `${name}: skipped`;
  const browser = await browserType.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    const registerCalls = [];
    const viewStates = [];
    let navigations = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("__TROOM_SW_REGISTER__")) registerCalls.push(text.slice("__TROOM_SW_REGISTER__".length));
      if (text.startsWith("__TROOM_VIEW__")) viewStates.push(JSON.parse(text.slice("__TROOM_VIEW__".length)));
    });
    await page.addInitScript(() => {
      try {
        const originalRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = (...args) => {
          console.info(`__TROOM_SW_REGISTER__${String(args[0])}`);
          return originalRegister(...args);
        };
      } catch {}
      document.addEventListener("DOMContentLoaded", () => {
        const capture = () => console.info(`__TROOM_VIEW__${JSON.stringify({
          boot: !document.querySelector("#boot-view")?.hidden,
          login: !document.querySelector("#login-view")?.hidden,
          app: !document.querySelector("#app-view")?.hidden,
          loading: document.querySelector("#entry-list")?.textContent?.includes("読み込んでいます") || false,
          entry: document.querySelector("#entry-list")?.textContent?.includes("起動確認") || false
        })}`);
        capture();
        new MutationObserver(capture).observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ["hidden"] });
      });
    });

    await page.goto(`${origin}/diary/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#app-view:not([hidden])");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(300);

    registerCalls.length = 0;
    viewStates.length = 0;
    navigations = 0;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#app-view:not([hidden])");
    await page.waitForTimeout(800);

    assert.equal(navigations, 1, `${name}: 同一buildの起動でfull reloadしない`);
    assert.equal(registerCalls.length, 1, `${name}: 1 navigationにつきService Worker登録は1回`);
    assert.match(registerCalls[0], /^\/diary\/service-worker\.js\?v=diary-[a-f0-9]{12}$/, `${name}: build付きURLだけを登録`);
    assert.equal(viewStates.filter((state) => state.login).length, 0, `${name}: 認証済み起動でログイン画面を表示しない`);
    const appStates = viewStates.filter((state) => state.app);
    assert.equal(appStates.length, 1, `${name}: 日記本体を1回だけ表示`);
    assert.equal(appStates[0].loading, false, `${name}: 読み込み途中の一覧を見せない`);
    assert.equal(appStates[0].entry, true, `${name}: 初期日記を揃えてから表示`);
    await context.close();
    return `${name}: ok`;
  } finally {
    await browser.close();
  }
}

try {
  const results = [
    await verifyStartup(chromium, "chromium"),
    await verifyStartup(firefox, "firefox")
  ];
  process.stdout.write(`Diary startup stability passed (${results.join(", ")}).\n`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
