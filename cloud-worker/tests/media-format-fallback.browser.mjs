import assert from "node:assert/strict";
import { engines, startUIFixture, preparePage } from "./ui-fixture.mjs";

const ts = Buffer.alloc(188 * 3);
ts[0] = ts[188] = ts[376] = 0x47;
const mp4 = Buffer.from([0, 0, 0, 24, ...Buffer.from("ftypisom"), 0, 0, 0, 0, ...Buffer.from("isommp42")]);
const fixture = await startUIFixture(undefined, {
  handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    const body = url.pathname.endsWith("/ts-fallback") ? ts : url.pathname.endsWith("/mp4-fallback") ? mp4 : null;
    if (!body) return false;
    if (req.headers.range === "bytes=0-16383") {
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes 0-${body.length - 1}/${body.length}`,
        "Content-Length": body.length,
        "Cache-Control": "no-store"
      });
    } else {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
    }
    res.end(body);
    return true;
  }
});

async function installPlayerStub(page) {
  await page.evaluate(() => {
    globalThis.__mpegPlayers = [];
    globalThis.__formatUpdates = [];
    globalThis.mpegts = {
      Events: { ERROR: "error" },
      isSupported: () => true,
      createPlayer(options) {
        const handlers = {};
        const player = {
          options,
          handlers,
          destroyed: false,
          on(name, callback) { handlers[name] = callback; },
          attachMediaElement(media) { this.media = media; },
          load() { this.media.dataset.mpegType = options.type; },
          unload() {},
          detachMediaElement() {},
          destroy() { this.destroyed = true; }
        };
        __mpegPlayers.push(player);
        return player;
      }
    };
    globalThis.TCloudMedia = {
      ...TCloudMedia,
      updateMediaFormat: async (token, detected) => { __formatUpdates.push({ token, ...detected }); return true; },
      markPlaying() {}
    };
  });
}

try {
  for (const [name, engine, launch] of engines) {
    const browser = await engine.launch({ headless: true, ...launch });
    try {
      const normal = await browser.newPage();
      await preparePage(normal, fixture.origin, 2);
      await installPlayerStub(normal);
      await normal.evaluate((origin) => {
        const file = __test.state.files.find((item) => item.mediaKind === "video");
        file.name = "disguised.mp4";
        file.mimeType = "video/mp4";
        delete file.containerType;
        __test.videoFixture(`${origin}/cloud/local-media/ts-fallback`);
      }, fixture.origin);
      await normal.locator('.file-card[data-file-id="2"] > button:first-child').click();
      await normal.waitForSelector("#preview-stage video");
      await normal.locator("#preview-stage video").evaluate((video) => {
        Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
        video.dispatchEvent(new Event("error"));
      });
      await normal.waitForFunction(() => document.querySelector("#preview-stage video")?.dataset.mpegType === "m2ts");
      assert.deepEqual(await normal.evaluate(() => ({
        updates: __formatUpdates.map((item) => item.container),
        type: document.querySelector("#preview-stage video").dataset.mpegType,
        container: __test.state.files.find((item) => item.mediaKind === "video").containerType
      })), { updates: ["mpeg-ts"], type: "m2ts", container: "mpeg-ts" }, `${name}: .mp4 MPEG-TS fallback`);
      await normal.close();

      const shared = await browser.newPage();
      await shared.goto(`${fixture.origin}/cloud/share/${"A".repeat(43)}`);
      await shared.waitForFunction(() => globalThis.__share);
      await shared.evaluate((origin) => {
        __share.bindEvents();
        __share.videoFixture(`${origin}/cloud/local-media/mp4-fallback`);
        __share.prepare([{ id: 8, name: "disguised.ts", mediaKind: "video", mimeType: "video/mp2t", createdAt: "2026-09-25 00:00:00", sizeBytes: 24 }]);
        __share.renderSortedItems();
      }, fixture.origin);
      await installPlayerStub(shared);
      await shared.locator("#items .file > button:first-child").click();
      await shared.waitForFunction(() => __mpegPlayers.length === 1);
      await shared.evaluate(() => __mpegPlayers[0].handlers.error());
      await shared.waitForFunction(() => __formatUpdates[0]?.container === "mp4");
      assert.deepEqual(await shared.evaluate(() => ({
        updates: __formatUpdates.map((item) => item.container),
        destroyed: __mpegPlayers[0].destroyed,
        route: TCloudMediaFormat.mpegContainerType(__share.state.files[0]),
        container: __share.state.files[0].containerType
      })), { updates: ["mp4"], destroyed: true, route: "", container: "mp4" }, `${name}: .ts MP4 native fallback`);
      await shared.close();
      console.log(`PASS native-first format fallback (${name})`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await fixture.close();
}
