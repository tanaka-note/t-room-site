import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../public/cloud.js", import.meta.url), "utf8");
const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = await fs.readFile(new URL("../public/cloud.css", import.meta.url), "utf8");

const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  TCloudMedia: {
    safeFilename(value) {
      return String(value || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "download";
    }
  }
});
vm.runInContext(source, context);

context.folderRecords = [
  { file: { name: "a.jpg" }, relativePath: "旅行/2026/夏/a.jpg" },
  { file: { name: "b.mov" }, relativePath: "旅行/2026/b.mov" },
  { file: { name: "c.pdf" }, relativePath: "書類/税金/c.pdf" }
];
const selection = vm.runInContext("normalizeFolderSelection(folderRecords)", context);
assert.deepEqual([...selection.roots], ["書類", "旅行"]);
assert.deepEqual([...selection.directories], ["書類", "旅行", "書類/税金", "旅行/2026", "旅行/2026/夏"]);
assert.equal(selection.files.length, 3);

const existing = new Set(["旅行"]);
context.mockDirectory = {
  async getDirectoryHandle(name, options = {}) {
    if (options.create) {
      existing.add(name);
      return { name };
    }
    if (existing.has(name)) return { name };
    const error = new Error("not found");
    error.name = "NotFoundError";
    throw error;
  }
};
const unique = await vm.runInContext('createUniqueDirectoryHandle(mockDirectory, "旅行")', context);
assert.equal(unique.name, "旅行 (1)");

assert.match(html, /id="folder-input"[^>]*webkitdirectory/);
assert.match(html, /id="desktop-folder-upload-action"/);
assert.match(html, /id="download-folder-button"/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.desktop-only \{ display: none !important; \}/);
assert.match(source, /collectFolderDownloads/);
assert.match(source, /downloadDisplayName/);

console.log("desktop folder upload and download: ok");
