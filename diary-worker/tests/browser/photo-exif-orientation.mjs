import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require("playwright");
const publicRoot = fileURLToPath(new URL("../../public/", import.meta.url));
const staticFiles = new Map([
  ["/diary/", ["index.html", "text/html; charset=utf-8"]],
  ["/diary/diary.js", ["diary.js", "text/javascript; charset=utf-8"]],
  ["/diary/diary.css", ["diary.css", "text/css; charset=utf-8"]],
  ["/diary/troom-date-picker.js", ["troom-date-picker.js", "text/javascript; charset=utf-8"]],
  ["/diary/troom-date-picker.css", ["troom-date-picker.css", "text/css; charset=utf-8"]]
]);
const photoIdPattern = /name="id"\r\n\r\n([0-9a-f-]{36})/i;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/diary/api/")) {
    const apiPath = url.pathname.slice("/diary/api".length);
    if (apiPath === "/session") {
      return sendJson(response, 200, {
        authenticated: true, role: "admin", accountName: "テスト", householdId: "main-household",
        activeHouseholdId: "main-household", canManageEntries: true, canViewTrash: true,
        canPermanentlyDelete: true, canViewInvestment: false
      });
    }
    if (apiPath === "/meta") return sendJson(response, 200, { draftCount: 0, months: [], tags: [] });
    if (apiPath === "/entries" && request.method === "GET") return sendJson(response, 200, { entries: [], hasMore: false });
    if (apiPath === "/photo-upload-sessions" && request.method === "POST") {
      return sendJson(response, 200, { uploadSession: { id: crypto.randomUUID(), expiresAt: "2026-09-04T00:00:00.000Z" } });
    }
    if (/^\/photo-upload-sessions\/[0-9a-f-]{36}\/photos$/.test(apiPath) && request.method === "POST") {
      const body = (await readRequestBody(request)).toString("latin1");
      const id = body.match(photoIdPattern)?.[1];
      assert.ok(id, "photo upload must contain a UUID");
      const width = body.match(/name="width"\r\n\r\n(\d+)/)?.[1] || "0";
      const height = body.match(/name="height"\r\n\r\n(\d+)/)?.[1] || "0";
      return sendJson(response, 200, { photo: {
        id, fileName: "fixture.jpg", contentType: "image/jpeg", originalSize: 1,
        width: Number(width), height: Number(height), createdByName: "テスト", createdAt: "2026-09-03T00:00:00.000Z",
        thumbnailUrl: "/diary/api/photos/" + id + "/thumbnail", displayUrl: "/diary/api/photos/" + id + "/display",
        originalUrl: "/diary/api/photos/" + id + "/original"
      }});
    }
    return sendJson(response, 200, {});
  }
  const route = staticFiles.get(url.pathname);
  if (route) {
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" });
    response.end(await readFile(publicRoot + "/" + route[0]));
    return;
  }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end("");
});

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function browserExecutable(name) {
  const configured = process.env["TROOM_" + name.toUpperCase() + "_EXECUTABLE"];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const firefoxPaths = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("firefox-"))
        .sort((left, right) => right.name.localeCompare(left.name, "en", { numeric: true }))
        .map((entry) => join(playwrightRoot, entry.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [...firefoxPaths, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

function addExifOrientation(jpeg, orientation, littleEndian) {
  const tiff = littleEndian
    ? [
        0x49, 0x49, 0x2a, 0, 0x08, 0, 0, 0,
        0x01, 0, 0x12, 0x01, 0x03, 0, 0x01, 0, 0, 0,
        orientation, 0, 0, 0, 0, 0, 0, 0
      ]
    : [
        0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 0x08,
        0, 0x01, 0x01, 0x12, 0, 0x03, 0, 0, 0, 0x01,
        0, orientation, 0, 0, 0, 0, 0, 0
      ];
  const exif = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
  const segmentLength = exif.length + 2;
  const app1 = Uint8Array.from([0xff, 0xe1, segmentLength >> 8, segmentLength & 0xff, ...exif]);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from(app1), jpeg.subarray(2)]);
}

async function createRasterFixture(page, type, width, height) {
  const base64 = await page.evaluate(({ imageType, fixtureWidth, fixtureHeight }) => {
    const canvas = document.createElement("canvas");
    canvas.width = fixtureWidth;
    canvas.height = fixtureHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e00000";
    context.fillRect(0, 0, fixtureWidth / 2, fixtureHeight / 2);
    context.fillStyle = "#00c000";
    context.fillRect(fixtureWidth / 2, 0, fixtureWidth / 2, fixtureHeight / 2);
    context.fillStyle = "#0040e0";
    context.fillRect(0, fixtureHeight / 2, fixtureWidth / 2, fixtureHeight / 2);
    context.fillStyle = "#e0c000";
    context.fillRect(fixtureWidth / 2, fixtureHeight / 2, fixtureWidth / 2, fixtureHeight / 2);
    return canvas.toDataURL(imageType, 1).split(",")[1];
  }, { imageType: type, fixtureWidth: width, fixtureHeight: height });
  return Buffer.from(base64, "base64");
}

async function createJpegFixture(page, orientation, littleEndian) {
  const jpeg = await createRasterFixture(page, "image/jpeg", 80, 40);
  return addExifOrientation(jpeg, orientation, littleEndian);
}

async function inspectUploads(page) {
  return page.evaluate(async () => {
    const decode = async (blob) => {
      const bitmap = await window.__nativeCreateImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      const pixel = (x, y) => [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)];
      return {
        width: canvas.width, height: canvas.height,
        corners: [
          pixel(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.25)),
          pixel(Math.floor(canvas.width * 0.75), Math.floor(canvas.height * 0.25)),
          pixel(Math.floor(canvas.width * 0.25), Math.floor(canvas.height * 0.75)),
          pixel(Math.floor(canvas.width * 0.75), Math.floor(canvas.height * 0.75))
        ]
      };
    };
    const bytes = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];
    return Promise.all(window.__photoUploads.map(async (upload) => ({
      id: upload.id,
      fileName: upload.fileName,
      width: upload.width,
      height: upload.height,
      original: await bytes(upload.original),
      display: { type: upload.display.type, ...(await decode(upload.display)) },
      thumbnail: { type: upload.thumbnail.type, ...(await decode(upload.thumbnail)) }
    })));
  });
}

function classifyColor(pixel) {
  const colors = new Map([
    ["red", [224, 0, 0]],
    ["green", [0, 192, 0]],
    ["blue", [0, 64, 224]],
    ["yellow", [224, 192, 0]]
  ]);
  return [...colors.entries()].sort((left, right) => colorDistance(pixel, left[1]) - colorDistance(pixel, right[1]))[0][0];
}

function colorDistance(actual, expected) {
  return actual.reduce((total, value, index) => total + ((value - expected[index]) ** 2), 0);
}

async function runBrowser(browserType, name, executablePath, contextOptions = {}) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...contextOptions });
    await page.addInitScript(() => {
      window.__nativeCreateImageBitmap = window.createImageBitmap.bind(window);
      window.__photoUploads = [];
      const nativeFetch = window.fetch.bind(window);
      window.createImageBitmap = (source, options) => {
        if (options !== undefined) return Promise.reject(new TypeError("imageOrientation options are not allowed"));
        return window.__nativeCreateImageBitmap(source);
      };
      window.fetch = async (resource, init = {}) => {
        const requestUrl = new URL(typeof resource === "string" ? resource : resource.url, window.location.href);
        if (init.method === "POST" && /\/diary\/api\/photo-upload-sessions\/[0-9a-f-]+\/photos$/i.test(requestUrl.pathname) && init.body instanceof FormData) {
          const parts = Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, value instanceof Blob ? value : String(value)]));
          window.__photoUploads.push({
            id: parts.id,
            fileName: parts.original.name,
            width: Number(parts.width),
            height: Number(parts.height),
            original: parts.original,
            display: parts.display,
            thumbnail: parts.thumbnail
          });
        }
        return nativeFetch(resource, init);
      };
    });
    await page.goto(origin + "/diary/");
    await page.waitForSelector("#app-view:not([hidden])");
    await page.click("#new-entry-button");
    await page.waitForSelector("#editor-dialog[open]");
    const fixtures = [
      {
        label: "landscape PNG", name: "landscape.png", mimeType: "image/png",
        buffer: await createRasterFixture(page, "image/png", 60, 30),
        expected: { width: 60, height: 30, corners: ["red", "green", "blue", "yellow"] }
      },
      {
        label: "portrait PNG", name: "portrait.png", mimeType: "image/png",
        buffer: await createRasterFixture(page, "image/png", 30, 60),
        expected: { width: 30, height: 60, corners: ["red", "green", "blue", "yellow"] }
      }
    ];
    const orientationExpectations = new Map([
      [1, { width: 80, height: 40, corners: ["red", "green", "blue", "yellow"] }],
      [2, { width: 80, height: 40, corners: ["green", "red", "yellow", "blue"] }],
      [3, { width: 80, height: 40, corners: ["yellow", "blue", "green", "red"] }],
      [4, { width: 80, height: 40, corners: ["blue", "yellow", "red", "green"] }],
      [5, { width: 40, height: 80, corners: ["red", "blue", "green", "yellow"] }],
      [6, { width: 40, height: 80, corners: ["blue", "red", "yellow", "green"] }],
      [7, { width: 40, height: 80, corners: ["yellow", "green", "blue", "red"] }],
      [8, { width: 40, height: 80, corners: ["green", "yellow", "red", "blue"] }]
    ]);
    for (const littleEndian of [true, false]) {
      const byteOrder = littleEndian ? "little-endian" : "big-endian";
      for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
        fixtures.push({
          label: "Orientation " + orientation + " " + byteOrder,
          name: "orientation-" + orientation + "-" + byteOrder + ".jpg",
          mimeType: "image/jpeg",
          buffer: await createJpegFixture(page, orientation, littleEndian),
          expected: orientationExpectations.get(orientation)
        });
      }
    }
    const chooserPromise = page.waitForEvent("filechooser");
    await page.click("#add-photo-button");
    const chooser = await chooserPromise;
    await chooser.setFiles(fixtures.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    await page.waitForSelector("#editor-photo-list .editor-photo-card:nth-child(18)");
    await page.waitForFunction(() => window.__photoUploads.length === 18);
    const uploads = await inspectUploads(page);
    assert.equal(uploads.length, fixtures.length, name + ": all PNG and EXIF fixtures must upload");
    for (const fixture of fixtures) {
      const upload = uploads.find((candidate) => candidate.fileName === fixture.name);
      assert.ok(upload, name + " " + fixture.label + ": upload must be captured");
      const output = fixture.expected;
      assert.deepEqual(upload.original, [...fixture.buffer], name + " " + fixture.label + ": original must be unchanged");
      assert.deepEqual([upload.width, upload.height], [output.width, output.height],
        name + " " + fixture.label + ": upload metadata dimensions must be normalized");
      for (const variant of [upload.display, upload.thumbnail]) {
        assert.equal(variant.type, "image/webp", name + " " + fixture.label + ": derived image must be WebP");
        assert.deepEqual([variant.width, variant.height], [output.width, output.height],
          name + " " + fixture.label + ": dimensions must be normalized");
        assert.deepEqual(variant.corners.map(classifyColor), output.corners,
          name + " " + fixture.label + ": corner pixels must reflect the orientation transform");
      }
    }
  } finally {
    await browser.close();
  }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
try {
  const chromiumPath = browserExecutable("chromium");
  const firefoxPath = browserExecutable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await runBrowser(chromium, "Chromium", chromiumPath);
  await runBrowser(firefox, "Firefox", firefoxPath);
  await runBrowser(chromium, "Touch", chromiumPath, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await runBrowser(webkit, "WebKit", undefined);
  process.stdout.write("Portrait/landscape PNG and little-/big-endian EXIF Orientation 1-8 normalization passed in Chromium, Firefox, WebKit, and touch-equivalent Chromium.\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
