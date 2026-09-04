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
  id: "job_browser_1", status: "analyzed", sourceHostname: "media.example", sourcePathHint: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  analysis: {
    site: "media.example", finalHostname: "media.example", extractor: "direct", title: "<img src=x onerror=alert(1)>",
    media: [{ mediaId: "direct", title: "安全な動画", mediaType: "video", container: "webm", videoCodec: "vp9", audioCodec: "opus", delivery: "direct", downloadable: true }]
  }
};
const pendingAnalysis = { ...analysis, status: "analyzing", analysis: {} };
const youtubeAnalysis = {
  ...analysis,
  id: "job_browser_youtube",
  sourceHostname: "www.youtube.com",
  analysis: {
    ...analysis.analysis,
    site: "YouTube",
    finalHostname: "www.youtube.com",
    extractor: "Youtube",
    media: analysis.analysis.media.map((item) => ({ ...item, downloadable: false }))
  }
};
const pendingYoutubeAnalysis = { ...youtubeAnalysis, status: "analyzing", analysis: {} };
const analyzeBodies = [];
const emptyUsage = {
  analyzeRequests: 2, downloadRequests: 1, processingSuccesses: 1, fileDeliveryStarts: 1,
  deleted: 0, expired: 0, sourceBytes: 2048, r2StoredBytes: 1024, deliveredBytes: 1024,
  rejected: 1, failed: 0,
  normalization: { PASS_THROUGH: 1, REMUX: 0, PARTIAL_TRANSCODE: 0, FULL_TRANSCODE: 0, NOT_APPLICABLE: 0, UNKNOWN: 0 },
  security: { malware_detected: 0, yara_detected: 0, clamav_error: 0, yara_error: 0, scanner_timeout: 0, scanner_unavailable: 0, file_type_mismatch: 0, malformed_media: 0, processing_budget_exceeded: 0, deadline_exceeded: 0, ssrf_rejected: 0, rate_limited: 1, other_reject: 0, other_failed: 0 }
};
const usageResponse = {
  periods: { today: emptyUsage, month: emptyUsage, all: emptyUsage },
  signals: { alerts: ["本日、rate limitによる拒否が発生しています。"] },
  recentDaily: [{ date: "2026-09-04", processingSuccesses: 1, fileDeliveryStarts: 1, rejected: 1, failed: 0 }],
  pricing: { estimatedAdditionalUsd: 0, pricingAsOf: "2026-09-04", components: [{ name: "Queues operations", measured: true, available: true, estimatedAdditionalUsd: 0 }, { name: "D1 rows read", measured: false, available: false, estimatedAdditionalUsd: null }], notes: ["正式な請求額はCloudflare Billingを確認してください。"] }
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/security/passkey-client.js" || url.pathname === "/assets/pwa-auto-update.js") {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    return response.end("window.TRoomPasskeys={authenticate:async()=>({handoff:{handoffToken:'test'}})};");
  }
  if (url.pathname === "/downloader/api/session") return json(response, 200, { authenticated: true, isParent: !String(request.headers.cookie || "").includes("test-role=member") });
  if (url.pathname === "/downloader/api/jobs" && request.method === "GET") return json(response, 200, { jobs: [] });
  if (url.pathname === "/downloader/api/admin/usage" && request.method === "GET") return json(response, 200, usageResponse);
  if (url.pathname === "/downloader/api/analyze" && request.method === "POST") {
    const body = await requestJson(request);
    analyzeBodies.push(body);
    return json(response, 202, { job: String(body.url || "").includes("youtube.com") ? pendingYoutubeAnalysis : pendingAnalysis });
  }
  if (url.pathname === "/downloader/api/jobs/job_browser_1") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    return json(response, 200, { job: analysis });
  }
  if (url.pathname === "/downloader/api/jobs/job_browser_youtube") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    return json(response, 200, { job: youtubeAnalysis });
  }
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

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
      await page.locator("#usage-section").waitFor({ state: "visible" });
      assert.match(await page.locator("#usage-summary").textContent(), /実ファイル取得/);
      assert.match(await page.locator("#usage-summary").textContent(), /今月推定追加/);
      assert.match(await page.locator("#usage-capacity").textContent(), /R2へ保存/);
      assert.match(await page.locator("#usage-alert").textContent(), /rate limit/);
      await page.locator("button[data-period='month']").click();
      assert.equal(await page.locator("button[data-period='month']").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("meta[name=robots]").getAttribute("content"), "noindex,nofollow,noarchive,nosnippet,noimageindex");
      await page.locator("#source-url").fill("https://media.example/clip.webm");
      await page.locator("#analyze-button").click();
      await page.locator("#progress-view").waitFor({ state: "visible" });
      assert.match(await page.locator("#progress-label").textContent(), /解析/);
      await page.locator("#analysis-view").waitFor({ state: "visible" });
      assert.equal(await page.locator("#analysis-title").textContent(), analysis.analysis.title);
      assert.equal(await page.locator("#analysis-title img").count(), 0, `${name}: analysis text must not create markup`);
      assert.match(await page.locator(".media-choice small").first().textContent(), /最終形式 MP4/);
      assert.equal(await page.locator("#download-button").isEnabled(), true);
      assert.equal(await page.locator("#youtube-rights-notice").isHidden(), true);
      await page.locator("#source-url").fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
      await page.locator("#youtube-rights-notice").waitFor({ state: "visible" });
      assert.equal(await page.locator("#youtube-rights-confirmed").getAttribute("required"), "");
      await page.locator("#youtube-rights-confirmed").check();
      await page.locator("#analyze-button").click();
      await page.locator("#youtube-rights-notice").waitFor({ state: "visible" });
      assert.equal(await page.locator("#youtube-rights-confirmed").isChecked(), true);
      assert.match(await page.locator("#youtube-rights-notice").textContent(), /自分が投稿した動画/);
      assert.equal(analyzeBodies.at(-1).youtubeRightsConfirmed, true);
      assert.equal(errors.length, 0, `${name}: ${errors.join("; ")}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      assert.equal(overflow, true, `${name}: mobile layout must not overflow horizontally`);
      const member = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await member.context().addCookies([{ name: "test-role", value: "member", url: target }]);
        await member.goto(`${target}?role=member`, { waitUntil: "networkidle" });
        await member.locator("#app-view").waitFor({ state: "visible" });
        assert.equal(await member.locator("#usage-section").isHidden(), true, `${name}: non-parent UI must stay hidden`);
      } finally {
        await member.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("Downloader browser: Chromium / Firefox PASS");
