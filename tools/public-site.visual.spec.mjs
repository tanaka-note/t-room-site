import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../diary-worker/package.json", import.meta.url));
const { test, expect } = require("playwright/test");
const tools = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(tools, "../.site-assets/");
const baselineRoot = resolve(tools, "public-site-visual-baselines");
const updateVisuals = process.env.TROOM_UPDATE_VISUALS === "1";
const mime = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json"]
]);

const pages = [
  {
    name: "home", path: "/index.html", selectors: [".hero", ".hero-statement", ".topic-grid", ".topic-card", ".recent-section"],
    regions: [["rooms", "#topics"], ["latest", "#posts"]],
    relations: [["rooms-heading-to-grid", "#topics .section-heading", ".topic-grid"], ["latest-heading-to-list", "#posts .section-heading", ".recent-list"]]
  },
  { name: "articles", path: "/articles.html", selectors: [".sub-hero", ".section", ".recent-list"] },
  { name: "public-diary", path: "/diary.html", selectors: [".diary-hero", ".diary-layout", ".diary-panel", ".diary-search-card", ".diary-search-box input"] },
  {
    name: "investment", path: "/investment.html", selectors: [".investment-hero", ".investment-layout", ".investment-panel", ".market-card-grid", ".market-card"],
    regions: [["market", ".market-panel"], ["articles", ".investment-articles-panel"]],
    relations: [["market-note-to-grid", ".market-note", ".market-card-grid"], ["articles-title-to-list", ".investment-articles-panel h2", ".investment-article-list"]]
  },
  {
    name: "learning", path: "/learning/index.html", selectors: [".learning-hero", ".learning-layout", ".learning-panel", ".learning-law-grid", ".learning-law-card"],
    regions: [["law-group", ".learning-law-group:first-of-type"]],
    relations: [["search-to-map", ".learning-search-card", ".learning-map-groups"]]
  },
  { name: "learning-article", path: "/learning/sharoushi/logs/011.html", selectors: [".learning-article", ".learning-article-header", ".learning-article-body", ".learning-table"] },
  { name: "games", path: "/game.html", selectors: [".game-hero", ".game-library-grid", ".game-library-card"] },
  {
    name: "game-screen", path: "/blocks-game.html", selectors: [".game-hero", ".game-layout", ".game-panel", ".game-frame", ".game-message"],
    regions: [["game", ".game-panel"]],
    relations: [["hud-to-frame", ".game-hud", ".game-frame"]]
  },
  { name: "columns", path: "/thought.html", selectors: [".thought-hero", ".thought-shell", ".thought-section", ".thought-article-card", ".thought-series-card"] },
  {
    name: "column-article", path: "/columns/music/001.html", selectors: [".thought-reading-shell", ".thought-reading", ".thought-body", ".thought-article-nav"],
    regions: [["body-opening", ".thought-body > p:first-of-type"]],
    relations: [["title-to-body", ".thought-reading > h1", ".thought-body"]]
  }
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

async function visualMetrics(page, selectors, relations = []) {
  return page.evaluate(({ selectors, relations, viewport }) => {
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
    if (relations.length) result.relations = {};
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
    for (const [name, fromSelector, toSelector] of relations) {
      const from = document.querySelector(fromSelector);
      const to = document.querySelector(toSelector);
      if (!from || !to) {
        result.relations[name] = null;
        continue;
      }
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      result.relations[name] = {
        verticalGap: toRect.top - fromRect.bottom,
        leftOffset: toRect.left - fromRect.left
      };
    }
    return result;
  }, { selectors, relations, viewport: page.viewportSize() });
}

async function assertWebFont(page, path) {
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    const samples = [
      ["400", await document.fonts.load('400 16px "Noto Sans JP"', "日本語")],
      ["700", await document.fonts.load('700 16px "Noto Sans JP"', "日本語")]
    ];
    return Object.fromEntries(samples.map(([weight, faces]) => [weight, faces.map(face => ({ family: face.family, status: face.status }))]));
  });
  for (const weight of ["400", "700"]) {
    expect(loaded[weight].length, `${path}: Noto Sans JP ${weight} face`).toBeGreaterThan(0);
    expect(loaded[weight].every(face => face.family.replaceAll('"', "") === "Noto Sans JP" && face.status === "loaded"), `${path}: Noto Sans JP ${weight} loaded`).toBe(true);
  }
}

function rounded(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => typeof item === "number" ? round(item) : item));
}

async function compareMetrics(metrics, entry, projectName) {
  const path = resolve(baselineRoot, projectName, `${entry.name}.json`);
  const actual = rounded(metrics);
  if (updateVisuals) {
    await mkdir(resolve(baselineRoot, projectName), { recursive: true });
    await writeFile(path, JSON.stringify(actual, null, 2), "utf8");
  }
  const expected = JSON.parse(await readFile(path, "utf8"));
  expect(actual, `${entry.path}: visual metrics`).toEqual(expected);
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
    await assertWebFont(page, entry.path);
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    await page.evaluate(async () => {
      await Promise.all([...document.images].filter(image => image.getBoundingClientRect().top < innerHeight * 1.5).map(image => image.complete ? image.decode().catch(() => {}) : new Promise(resolveImage => {
        image.addEventListener("load", resolveImage, { once: true });
        image.addEventListener("error", resolveImage, { once: true });
      })));
    });
    for (const selector of entry.selectors) await expect(page.locator(selector).first(), `${entry.path}: ${selector}`).toBeVisible();
    const selectors = [".site-header", "main", "h1", ...entry.selectors, ".site-footer"];
    const metrics = await visualMetrics(page, [...new Set(selectors)], entry.relations);
    for (const [selector, value] of Object.entries(metrics.elements)) expect(value, `${entry.path}: ${selector}`).not.toBeNull();
    for (const [name, value] of Object.entries(metrics.relations || {})) expect(value, `${entry.path}: ${name}`).not.toBeNull();
    expect(metrics.document.scrollWidth, `${entry.path}: horizontal overflow`).toBe(metrics.document.clientWidth);
    expect(pageErrors, `${entry.path}: page errors`).toEqual([]);
    expect(localFailures, `${entry.path}: local request failures`).toEqual([]);
    await compareMetrics(metrics, entry, testInfo.project.name);
    await expect(page).toHaveScreenshot(`${entry.name}.png`);
    const header = page.locator(".site-header");
    await header.evaluate(element => element.style.setProperty("display", "none", "important"));
    await expect(header).toBeHidden();
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    for (const [name, selector] of entry.regions || []) {
      await expect(page.locator(selector).first(), `${entry.path}: ${selector}`).toHaveScreenshot(`${entry.name}-${name}.png`);
    }
    await header.evaluate(element => element.style.removeProperty("display"));
    testInfo.annotations.push({ type: "fixture", description: entry.path });
  });
}
