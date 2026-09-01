import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium, firefox } = require("playwright");
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const files = new Map([
  ["/downloader/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/downloader/downloader.css", ["public/downloader.css", "text/css; charset=utf-8"]],
  ["/downloader/downloader.js", ["public/downloader.js", "text/javascript; charset=utf-8"]],
]);
const analysis = {
  id: "job_browser_1", status: "analyzed", sourceHostname: "media.example", sourcePathHint: "/clip.webm",
  createdAt: "2026-09-01T00:00:00.000Z",
  analysis: {
    site: "media.example", finalHostname: "media.example", extractor: "direct", title: "<img src=x onerror=alert(1)>",
    media: [{ mediaId: "direct", title: "安全な動画", mediaType: "video", container: "webm", videoCodec: "vp9", audioCodec: "opus", delivery: "direct", downloadable: true }]
  }
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/security/passkey-client.js" || url.pathname === "/assets/pwa-auto-update.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end("window.TRoomPasskeys={authenticate:async()=>({handoff:{handoffToken:'test'}})};");
  }
  if (url.pathname === "/downloader/api/session") return json(response, 200, { authenticated: true });
  if (url.pathname === "/downloader/api/jobs" && request.method === "GET") return json(response, 200, { jobs: [] });
  if (url.pathname === "/downloader/api/analyze" && request.method === "POST") return json(response, 201, { job: analysis });
  const item = files.get(url.pathname);
  if (item) {
    response.writeHead(200, { "Content-Type": item[1], "Cache-Control": "no-store" });
    return response.end(await readFile(resolve(root, item[0])));
  }
  response.writeHead(404).end();
});

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

await new Promise((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
const address = server.address();
const target = `http://127.0.0.1:${address.port}/downloader/`;

try {
  for (const [name, engine] of [["Chromium", chromium], ["Firefox", firefox]]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(target, { waitUntil: "networkidle" });
      await page.locator("#app-view").waitFor({ state: "visible" });
      assert.equal(await page.locator("meta[name=robots]").getAttribute("content"), "noindex,nofollow,noarchive,nosnippet,noimageindex");
      await page.locator("#source-url").fill("https://media.example/clip.webm");
      await page.locator("#analyze-button").click();
      await page.locator("#analysis-view").waitFor({ state: "visible" });
      assert.equal(await page.locator("#analysis-title").textContent(), analysis.analysis.title);
      assert.equal(await page.locator("#analysis-title img").count(), 0, `${name}: analysis text must not create markup`);
      assert.match(await page.locator(".media-choice small").first().textContent(), /最終形式 MP4/);
      assert.equal(await page.locator("#download-button").isEnabled(), true);
      assert.equal(errors.length, 0, `${name}: ${errors.join("; ")}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      assert.equal(overflow, true, `${name}: mobile layout must not overflow horizontally`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("Downloader browser: Chromium / Firefox PASS");
