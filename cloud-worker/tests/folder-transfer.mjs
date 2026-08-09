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

context.moreFolderRecords = [
  { file: { name: "d.mp3", size: 10, lastModified: 1 }, relativePath: "音楽/歌手/d.mp3" }
];
context.firstFolderSelection = selection;
context.moreFolderSelection = vm.runInContext("normalizeFolderSelection(moreFolderRecords)", context);
const merged = vm.runInContext("mergeFolderSelections(firstFolderSelection, moreFolderSelection)", context);
assert.deepEqual([...merged.roots], ["音楽", "書類", "旅行"]);
assert.equal(merged.files.length, 4);

const mockFileEntry = (name) => ({
  name,
  isFile: true,
  isDirectory: false,
  file(resolve) { resolve({ name, size: 1, lastModified: 1 }); }
});
const mockDirectoryEntry = (name, children) => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader() {
    let read = false;
    return { readEntries(resolve) { resolve(read ? [] : (read = true, children)); } };
  }
});
const firstRoot = mockDirectoryEntry("写真", [mockFileEntry("a.jpg")]);
const secondRoot = mockDirectoryEntry("動画", [mockFileEntry("b.mp4")]);
context.multiFolderDrop = {
  items: [firstRoot, secondRoot].map((entry) => ({ kind: "file", webkitGetAsEntry() { return entry; } }))
};
const dropped = await vm.runInContext("folderSelectionFromDrop(multiFolderDrop)", context);
assert.deepEqual([...dropped.roots], ["写真", "動画"]);
assert.equal(dropped.files.length, 2);

const firstHandle = {
  kind: "directory",
  name: "音声",
  async *values() { yield { kind: "file", name: "a.flac", async getFile() { return { name: "a.flac", size: 2, lastModified: 2 }; } }; }
};
const secondHandle = {
  kind: "directory",
  name: "書籍",
  async *values() { yield { kind: "file", name: "b.pdf", async getFile() { return { name: "b.pdf", size: 3, lastModified: 3 }; } }; }
};
context.modernMultiFolderDrop = {
  items: [firstHandle, secondHandle].map((handle) => ({ kind: "file", async getAsFileSystemHandle() { return handle; } }))
};
const modernDropped = await vm.runInContext("folderSelectionFromDrop(modernMultiFolderDrop)", context);
assert.deepEqual([...modernDropped.roots], ["音声", "書籍"]);
assert.equal(modernDropped.files.length, 2);

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
assert.match(html, /id="folder-upload-more"/);
assert.match(source, /openFolderUploadDialog\(selection, \{ append: \$\("#folder-upload-dialog"\)\.open \}\)/);
assert.match(source, /if \(!dialog\.open\) dialog\.showModal\(\)/);
assert.match(html, /id="download-folder-button"/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.desktop-only \{ display: none !important; \}/);
assert.match(source, /collectFolderDownloads/);
assert.match(source, /downloadDisplayName/);

console.log("desktop folder upload and download: ok");
