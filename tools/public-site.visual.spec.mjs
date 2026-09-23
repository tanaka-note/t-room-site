import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../diary-worker/package.json", import.meta.url));
const { test, expect } = require("playwright/test");
const root = resolve(fileURLToPath(new URL("../.site-assets/", import.meta.url)));
const mime = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json"]
]);

const pages = [
  { name: "home", path: "/index.html", selectors: [".hero", ".hero-statement", ".topic-grid", ".topic-card", ".recent-section"] },
  { name: "articles", path: "/articles.html", selectors: [".sub-hero", ".section", ".recent-list"] },
  { name: "public-diary", path: "/diary.html", selectors: [".diary-hero", ".diary-layout", ".diary-panel", ".diary-search-card", ".diary-search-box input"] },
  { name: "investment", path: "/investment.html", selectors: [".investment-hero", ".investment-layout", ".investment-panel", ".market-card-grid", ".market-card"] },
  { name: "learning", path: "/learning/index.html", selectors: [".learning-hero", ".learning-layout", ".learning-panel", ".learning-law-grid", ".learning-law-card"] },
  { name: "learning-article", path: "/learning/sharoushi/logs/011.html", selectors: [".learning-article", ".learning-article-header", ".learning-article-body", ".learning-table"] },
  { name: "games", path: "/game.html", selectors: [".game-hero", ".game-library-grid", ".game-library-card"] },
  { name: "game-screen", path: "/blocks-game.html", selectors: [".game-hero", ".game-layout", ".game-panel", ".game-frame", ".game-message"] },
  { name: "columns", path: "/thought.html", selectors: [".thought-hero", ".thought-shell", ".thought-section", ".thought-article-card", ".thought-series-card"] },
  { name: "column-article", path: "/columns/music/001.html", selectors: [".thought-reading-shell", ".thought-reading", ".thought-body", ".thought-article-nav"] }
];

const marketFixture = {
  updatedAt: "2026-09-21T03:00:00.000Z",
  items: [
    { id: "nikkei225_ref", price: 45123, currency: "JPY", percentChange: 0.72, ok: true, fetchedAt: "2026-09-21T03:00:00.000Z" },
    { id: "sp500_ref", price: 6789.12, currency: "USD", percentChange: 0.31, ok: true, fetchedAt: "2026-09-21T03:00:00.000Z" },
    { id: "nasdaq100_ref", price: 25123.45, currency: "USD", percentChange: -0.18, ok: true, fetchedAt: "2026-09-21T03:00:00.000Z" },
    { id: "bitcoin", price: 112345.67, currency: "USD", percentChange: 1.24, ok: true, fetchedAt: "2026-09-21T03:00:00.000Z" },
    { id: "nifty50_ref", price: 26345.8, currency: "USD", percentChange: 0.09, ok: true, fetchedAt: "2026-09-21T03:00:00.000Z" }
  ]
};

let server;
let origin;

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://fixture.local");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("invalid path");
      await access(path);
      if (!(await stat(path)).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": mime.get(extname(path).toLowerCase()) || "application/octet-stream", "cache-control": "no-store" });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
});

function round(value) {
  return Math.round(value);
}

async function visualMetrics(page, selectors) {
  return page.evaluate(({ selectors, viewport }) => {
    const stableStyle = style => ({
      display: style.display,
      position: style.position,
      gridTemplateColumns: style.gridTemplateColumns,
      gap: style.gap,
      padding: style.padding,
      margin: style.margin,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      color: style.color,
      backgroundColor: style.backgroundColor,
      border: style.border,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow
    });
    const result = {
      viewport,
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      },
      elements: {}
    };
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) {
        result.elements[selector] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      result.elements[selector] = {
        rect: { x: rect.x, width: rect.width, height: rect.height },
        style: stableStyle(getComputedStyle(element))
      };
    }
    return result;
  }, { selectors, viewport: page.viewportSize() });
}

for (const entry of pages) {
  test(entry.name, async ({ page }, testInfo) => {
    const pageErrors = [];
    const localFailures = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => {
      if (request.url().startsWith(origin)) localFailures.push(`${request.url()} ${request.failure()?.errorText || "failed"}`);
    });
    await page.route("**/*", route => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin === "https://troom-market-worker.atsushi-vip.workers.dev") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(marketFixture) });
      }
      const host = requestUrl.hostname;
      if (host === "127.0.0.1" || host === "fonts.googleapis.com" || host === "fonts.gstatic.com") return route.continue();
      return route.abort("blockedbyclient");
    });
    const response = await page.goto(`${origin}${entry.path}`, { waitUntil: "domcontentloaded" });
    expect(response?.status(), entry.path).toBe(200);
    await page.locator("main").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    await page.evaluate(async () => {
      await Promise.all([...document.images].filter(image => image.getBoundingClientRect().top < innerHeight * 1.5).map(image => image.complete ? image.decode().catch(() => {}) : new Promise(resolveImage => {
        image.addEventListener("load", resolveImage, { once: true });
        image.addEventListener("error", resolveImage, { once: true });
      })));
    });
    for (const selector of entry.selectors) await expect(page.locator(selector).first(), `${entry.path}: ${selector}`).toBeVisible();
    const selectors = [".site-header", "main", "h1", ...entry.selectors, ".site-footer"];
    const metrics = await visualMetrics(page, [...new Set(selectors)]);
    for (const [selector, value] of Object.entries(metrics.elements)) expect(value, `${entry.path}: ${selector}`).not.toBeNull();
    expect(metrics.document.scrollWidth, `${entry.path}: horizontal overflow`).toBe(metrics.document.clientWidth);
    expect(pageErrors, `${entry.path}: page errors`).toEqual([]);
    expect(localFailures, `${entry.path}: local request failures`).toEqual([]);
    expect(JSON.stringify(metrics, (key, value) => typeof value === "number" ? round(value) : value, 2))
      .toMatchSnapshot(`${entry.name}.json`);
    await expect(page).toHaveScreenshot(`${entry.name}.png`);
    testInfo.annotations.push({ type: "fixture", description: entry.path });
  });
}
