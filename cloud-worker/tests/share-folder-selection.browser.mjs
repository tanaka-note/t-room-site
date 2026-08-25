import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../../diary-worker/package.json", import.meta.url));
const { chromium, firefox } = require("playwright");
const token = "A".repeat(43);
const [shareHtml, shareJs, shareCss] = await Promise.all([
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.css", import.meta.url), "utf8")
]);
const mockCrypto = `<script>
globalThis.TRoomCrypto = {
  deriveShareAuthProof: async () => "proof",
  unlockShareKey: async () => ({ targetKey: { kind: "root-key" } }),
  unlockFolderFromShare: async (folder) => ({ kind: "folder-key", id: folder.id }),
  unlockFolderFromParent: async (folder) => ({ kind: "child-key", id: folder.id }),
  unlockFileKey: async () => ({}),
  decryptFileMetadata: async () => ({}),
  decryptThumbnail: async () => new Uint8Array(),
  decryptFileChunk: async () => new Uint8Array()
};
globalThis.TCloudMedia = { releaseMedia() {} };
</script>`;
const browserHtml = shareHtml.replace(/<script\b[^>]*><\/script>/g, "").replace("</body>", `${mockCrypto}<script src="/cloud/share.js" defer></script></body>`);

function json(response, body, status = 200, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === `/cloud/api/public/shares/${token}`) return json(response, {
    targetType: "folder-selection", expiresAt: Math.floor(Date.now() / 1000) + 3600,
    passwordSalt: "salt", passwordWrappedKey: "key", passwordWrapIv: "iv"
  });
  if (url.pathname === `/cloud/api/public/shares/${token}/unlock`) return json(response, { authenticated: true, targetType: "folder-selection" }, 200, { "set-cookie": "test=1" });
  if (url.pathname === `/cloud/api/public/shares/${token}/items`) {
    const folderId = Number(url.searchParams.get("folderId") || 0);
    if (!folderId) return json(response, {
      targetType: "folder-selection", rootFolderId: 10, expiresAt: Math.floor(Date.now() / 1000) + 3600,
      folders: [
        { id: 10, parentId: null, name: "写真", cryptoVersion: 1, position: 0 },
        { id: 20, parentId: null, name: "動画", cryptoVersion: 1, position: 1, shareWrappedFolderKey: "wrapped", shareFolderKeyIv: "iv" }
      ], files: []
    });
    return json(response, {
      targetType: "folder-selection", rootFolderId: folderId, expiresAt: Math.floor(Date.now() / 1000) + 3600,
      folder: { id: folderId, parentId: null, name: folderId === 10 ? "写真" : "動画", cryptoVersion: 1 },
      folders: [], files: []
    });
  }
  if (url.pathname === "/cloud/share.css") {
    response.writeHead(200, { "content-type": "text/css" });
    return response.end(shareCss);
  }
  if (url.pathname === "/cloud/share.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    return response.end(shareJs);
  }
  if (url.pathname === `/cloud/share/${token}` || url.pathname === `/cloud/share/${token}/`) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(browserHtml);
  }
  response.writeHead(404).end();
});

function executable(name) {
  const configured = process.env[`TROOM_${name.toUpperCase()}_EXECUTABLE`];
  if (configured) return configured;
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "";
  const firefoxCandidates = name === "firefox" && playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot, { withFileTypes: true })
        .filter((item) => item.isDirectory() && item.name.startsWith("firefox-"))
        .sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))
        .map((item) => join(playwrightRoot, item.name, "firefox", "firefox.exe"))
    : [];
  const candidates = name === "firefox"
    ? [...firefoxCandidates, "C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"]
    : ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find(existsSync) || null;
}

async function run(browserType, name, executablePath, baseUrl) {
  const browser = await browserType.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/cloud/share/${token}`, { waitUntil: "networkidle" });
    await page.locator("#share-password").fill("temporary-password");
    await page.locator('#unlock-form button[type="submit"]').click();
    await page.waitForSelector("#browser-view:not([hidden])");
    assert.equal(await page.locator("#target-title").textContent(), "共有フォルダ（2件）", `${name}: 仮想共有root`);
    assert.deepEqual(await page.locator("#items .folder strong").allTextContents(), ["写真", "動画"], `${name}: 選択root一覧`);
    await page.getByRole("button", { name: /写真/ }).click();
    await page.waitForFunction(() => document.querySelector("#target-title")?.textContent === "写真");
    assert.equal(await page.locator("#breadcrumbs button").first().textContent(), "共有フォルダ（2件）", `${name}: rootパンくず`);
    await page.goBack();
    await page.waitForFunction(() => document.querySelector("#target-title")?.textContent === "共有フォルダ（2件）");
    const historyState = await page.evaluate(() => history.state);
    assert.equal(JSON.stringify(historyState).includes("password"), false, `${name}: HistoryへPWを保存しない`);
    assert.equal(JSON.stringify(historyState).includes("key"), false, `${name}: Historyへ鍵を保存しない`);
    assert.deepEqual(errors, [], `${name}: page error`);
  } finally {
    await browser.close();
  }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
try {
  const chromiumPath = executable("chromium");
  const firefoxPath = executable("firefox");
  if (!chromiumPath || !firefoxPath) throw new Error("Chromium/Firefox executable is required.");
  await run(chromium, "Chromium", chromiumPath, baseUrl);
  await run(firefox, "Firefox", firefoxPath, baseUrl);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("multiple-folder share browser root and history: ok");
