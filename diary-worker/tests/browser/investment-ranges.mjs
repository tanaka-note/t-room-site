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
  ".webmanifest": "application/manifest+json"
};
const records = investmentRecords();

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/diary/api/investment-history") {
    return sendJson(response, { asOf: records.at(-1).date, records });
  }
  if (url.pathname === "/assets/pwa-auto-update.js") return sendFile(response, updaterPath);
  const relativePath = url.pathname === "/diary/investment/"
    ? "investment.html"
    : url.pathname.replace(/^\/diary\//, "");
  const target = resolve(publicRoot, relativePath);
  if (!target.startsWith(`${publicRoot}${sep}`) && target !== publicRoot) return response.writeHead(404).end();
  try {
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    return sendFile(response, target);
  } catch {
    return response.writeHead(404).end();
  }
});

function investmentRecords() {
  const result = [];
  for (let year = 2022, month = 7; year < 2026 || (year === 2026 && month <= 7); month += 1) {
    if (month === 13) {
      year += 1;
      month = 1;
    }
    const day = year === 2022 && month === 7 ? 1 : new Date(Date.UTC(year, month, 0)).getUTCDate();
    const index = result.length;
    const total = 5_000_000 + index * 35_000 + (index % 3) * 12_000;
    result.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      total,
      cash: Math.round(total * 0.2),
      stocks: Math.round(total * 0.3),
      funds: Math.round(total * 0.35),
      bonds: 0,
      crypto: Math.round(total * 0.1),
      futures: 0,
      points: Math.round(total * 0.05),
      other: 0
    });
  }
  return result;
}

function sendJson(response, body) {
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function sendFile(response, path) {
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(await readFile(path));
}

function browserExecutable(name) {
  const configured = process.env[`TROOM_${name.toUpperCase()}_EXECUTABLE`];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const firefoxCandidates = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((candidate) => candidate.isDirectory() && candidate.name.startsWith("firefox-"))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .map((candidate) => join(playwrightRoot, candidate.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [...firefoxCandidates, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function run(browserType, name, executablePath, viewport) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/diary/investment/`, { waitUntil: "networkidle" });
    await page.waitForSelector("#dashboard:not([hidden])");

    assert.deepEqual(await page.locator("#range-controls button").allTextContents(), [
      "1ヶ月", "3ヶ月", "6ヶ月", "1年", "2年", "3年", "5年", "最長"
    ], `${name}: 実履歴約4年に応じた期間ボタン`);
    assert.equal(await page.locator("#header-as-of").textContent(), "2026年7月31日時点", `${name}: 上部基準日`);
    assert.equal(await page.locator("#composition-as-of").textContent(), "2026年7月31日時点", `${name}: 資産構成基準日`);

    await page.locator('button[data-range="5y"]').click();
    assert.equal(await page.locator("#change-label").textContent(), "表示期間の増減", `${name}: 不完全な5年を誤表示しない`);
    assert.equal(await page.locator("#rate-label").textContent(), "表示期間の増減率", `${name}: 不完全な5年率を誤表示しない`);
    assert.equal(await page.locator("#chart-period").textContent(), "2022.07.01 — 2026.07.31", `${name}: 実際の表示開始・終了日`);
    assert.equal(await page.locator('button[data-range="5y"]').getAttribute("aria-pressed"), "true");

    await page.locator('button[data-range="1m"]').click();
    assert.equal(await page.locator("#change-label").textContent(), "1ヶ月の増減", `${name}: 完全な短期KPI`);
    assert.equal(await page.locator("#chart-period").textContent(), "2026.06.30 — 2026.07.31", `${name}: 安全な1ヶ月抽出`);
    const layout = await page.evaluate(() => ({
      bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlsScrollable: document.querySelector("#range-controls").scrollWidth >= document.querySelector("#range-controls").clientWidth,
      chartWidth: document.querySelector("#asset-chart").getBoundingClientRect().width
    }));
    assert.ok(layout.bodyOverflow <= 1, `${name}: bodyの横方向レイアウト崩れなし`);
    assert.ok(layout.controlsScrollable, `${name}: 期間ボタン領域を操作可能`);
    assert.ok(layout.chartWidth > 0, `${name}: チャート描画領域あり`);
    assert.deepEqual(pageErrors, [], `${name}: page errorなし`);
    await context.close();
  } finally {
    await browser.close();
  }
}

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await run(chromium, "Chromium desktop", chromiumPath, { width: 1280, height: 900 });
  await run(chromium, "Chromium mobile", chromiumPath, { width: 390, height: 844 });
  await run(firefox, "Firefox desktop", firefoxPath, { width: 1280, height: 900 });
  await run(firefox, "Firefox mobile", firefoxPath, { width: 390, height: 844 });
  process.stdout.write("My Investment ranges passed in Chromium and Firefox on desktop and mobile viewports.\n");
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
