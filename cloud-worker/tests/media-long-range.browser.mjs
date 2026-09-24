import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devices, engines } from "./ui-fixture.mjs";

const MIB = 1024 * 1024;
const CHUNK_SIZE = 8 * MIB;
const CHUNK_COUNT = 25;
const FILE_SIZE = 200 * MIB;
const root = process.env.TCLOUD_TEST_SOURCE_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const videoFixture = readFileSync(resolve(root, "cloud-worker/tests/fixtures/thumbnail-codec-h264.mp4"));
const longChunkRequests = new Set();
let fixtureRequests = 0;

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/cloud/api/session") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ authenticated: req.headers["x-tcloud-session"] === "A" }));
      return;
    }
    if (url.pathname === "/cloud/api/files/1/view") {
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ""));
      const index = Number(match?.[1]) / (CHUNK_SIZE + 32);
      if (!Number.isInteger(index) || index < 0 || index >= CHUNK_COUNT) throw new Error("invalid long media Range");
      longChunkRequests.add(index);
      res.writeHead(206, { "Content-Type": "application/octet-stream" });
      res.end(Uint8Array.of(index));
      return;
    }
    if (url.pathname === "/cloud/api/files/2/view") {
      fixtureRequests += 1;
      res.writeHead(206, { "Content-Type": "application/octet-stream" });
      res.end(videoFixture);
      return;
    }
    if (url.pathname === "/cloud/crypto-vault.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`self.TRoomCrypto={async decryptFileChunk(_key,envelope,index){if(envelope.byteLength===1){return new Uint8Array(${CHUNK_SIZE}).fill(index).buffer;}return envelope.buffer.slice(envelope.byteOffset,envelope.byteOffset+envelope.byteLength);}};`);
      return;
    }
    if (url.pathname === "/cloud/offline-store.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(`{const chunks=new Map();self.TCloudOffline={supported:()=>true,getCacheLimitBytes:()=>${1024 * MIB},setCacheLimitBytes(){},getChunk:async(id,index)=>chunks.get(id+":"+index),putChunk:async(id,index,bytes)=>chunks.set(id+":"+index,bytes)};}`);
      return;
    }
    if (url.pathname === "/cloud/test.html") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><meta charset=utf-8><title>media range fixture</title>");
      return;
    }
    if (url.pathname === "/cloud/media-worker.js" || url.pathname === "/cloud/media-range.js") {
      const file = url.pathname.endsWith("media-worker.js") ? "media-worker.js" : "media-range.js";
      res.setHeader("Content-Type", "text/javascript");
      res.end(readFileSync(resolve(root, "cloud-worker/public", file)));
      return;
    }
    if (url.pathname.startsWith("/cloud/")) {
      res.setHeader("Content-Type", extname(url.pathname) === ".webmanifest" ? "application/manifest+json" : "application/octet-stream");
      res.end("fixture");
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine, launch] of engines) {
    longChunkRequests.clear();
    fixtureRequests = 0;
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      const context = await browser.newContext({ ...devices[name === "webkit" ? "iPhone 13" : "Pixel 7"] });
      const page = await context.newPage();
      await page.goto(`${origin}/cloud/test.html`);
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register("/cloud/media-worker.js", { scope: "/cloud/" });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise((resolveControl, reject) => {
            const timer = setTimeout(() => reject(new Error("service worker control timeout")), 10000);
            navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timer); resolveControl(); }, { once: true });
          });
        }
        globalThis.__registration = registration;
      });

      const longToken = `longrange${name}tokenfixture1234`;
      await registerMedia(page, longToken, {
        endpoint: "/cloud/api/files/1/view",
        expectedSession: "A",
        name: "long-fixture.mp4",
        sizeBytes: FILE_SIZE,
        chunkSizeBytes: CHUNK_SIZE,
        chunkCount: CHUNK_COUNT,
        encryptedSizeBytes: FILE_SIZE + CHUNK_COUNT * 32,
        storageId: `${name}:long`,
        mimeType: "video/mp4"
      });
      await page.evaluate((token) => navigator.serviceWorker.controller.postMessage({ type: "MEDIA_PLAYING", token }), longToken);
      await until(() => longChunkRequests.size === CHUNK_COUNT, `${name} prefetch of every chunk through EOF`);

      const result = await page.evaluate(async ({ token, fileSize, mib }) => {
        const response = await fetch(`/cloud/local-media/${token}`, { headers: { Range: "bytes=0-" } });
        const reader = response.body.getReader();
        let total = 0;
        let crossed64MiB = false;
        let crossed128MiB = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          crossed64MiB ||= total > 64 * mib;
          crossed128MiB ||= total > 128 * mib;
        }
        return {
          status: response.status,
          contentRange: response.headers.get("Content-Range"),
          contentLength: Number(response.headers.get("Content-Length")),
          total,
          crossed64MiB,
          crossed128MiB,
          expectedRange: `bytes 0-${fileSize - 1}/${fileSize}`
        };
      }, { token: longToken, fileSize: FILE_SIZE, mib: MIB });
      assert.deepEqual(result, {
        status: 206,
        contentRange: result.expectedRange,
        contentLength: FILE_SIZE,
        total: FILE_SIZE,
        crossed64MiB: true,
        crossed128MiB: true,
        expectedRange: result.expectedRange
      });

      const releaseTokens = [longToken];
      if (name === "chromium") {
        // Playwright's Windows WebKit build has no H.264 decoder. Chromium still
        // exercises the actual <video> path; both engines exercise the 200MiB SW stream.
        const videoToken = `videotest${name}tokenfixture1234`;
        releaseTokens.push(videoToken);
        await registerMedia(page, videoToken, {
          endpoint: "/cloud/api/files/2/view",
          expectedSession: "A",
          name: "fixture.mp4",
          sizeBytes: videoFixture.byteLength,
          chunkSizeBytes: 64 * 1024,
          chunkCount: 1,
          encryptedSizeBytes: videoFixture.byteLength + 32,
          storageId: "",
          mimeType: "video/mp4"
        });
        const video = await page.evaluate(async (token) => {
          const element = document.createElement("video");
          element.preload = "auto";
          element.muted = true;
          element.playsInline = true;
          element.src = `/cloud/local-media/${token}`;
          document.body.append(element);
          await new Promise((resolveMetadata, reject) => {
            const timer = setTimeout(() => reject(new Error(`video metadata timeout: ${element.error?.message || element.error?.code || "unknown"}`)), 10000);
            element.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolveMetadata(); }, { once: true });
            element.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`video error ${element.error?.code || "unknown"}`)); }, { once: true });
            element.load();
          });
          return { readyState: element.readyState, duration: element.duration };
        }, videoToken);
        assert.ok(video.readyState >= 1 && Number.isFinite(video.duration), "chromium <video> loads through the real Service Worker");
        assert.ok(fixtureRequests > 0, "chromium video fixture reached the encrypted endpoint");
      }
      await page.evaluate((tokens) => tokens.forEach((token) => navigator.serviceWorker.controller.postMessage({ type: "RELEASE_MEDIA", token })), releaseTokens);
      await context.close();
      console.log(`PASS ${name} mobile-context Service Worker streamed 200MiB past 64/128MiB${name === "chromium" ? " and a real <video> loaded" : ""}`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function registerMedia(page, token, descriptor) {
  await page.evaluate(async ({ token, descriptor }) => {
    const fileKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["decrypt"]);
    await new Promise((resolveRegistered, reject) => {
      const timer = setTimeout(() => reject(new Error("media registration timeout")), 10000);
      const onMessage = (event) => {
        if (event.data?.type !== "MEDIA_REGISTERED" || event.data.token !== token) return;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener("message", onMessage);
        resolveRegistered();
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      navigator.serviceWorker.controller.postMessage({ type: "REGISTER_MEDIA", token, descriptor, fileKey, cacheLimitBytes: 1024 * 1024 * 1024 });
    });
  }, { token, descriptor });
}

async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}
