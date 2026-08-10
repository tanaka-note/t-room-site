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
const dropped = await vm.runInContext("collectDroppedContent(multiFolderDrop)", context);
assert.deepEqual([...dropped.folderSelection.roots], ["写真", "動画"]);
assert.equal(dropped.folderSelection.files.length, 2);
assert.equal(dropped.looseFiles.length, 0);

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
const modernDropped = await vm.runInContext("collectDroppedContent(modernMultiFolderDrop)", context);
assert.deepEqual([...modernDropped.folderSelection.roots], ["音声", "書籍"]);
assert.equal(modernDropped.folderSelection.files.length, 2);

let dragPermissionActive = true;
const shiftSelectedHandles = ["資料", "映像", "音楽"].map((name, index) => ({
  kind: "directory",
  name,
  async *values() {
    yield { kind: "file", name: `${index}.dat`, async getFile() { return { name: `${index}.dat`, size: index + 1, lastModified: 10 + index }; } };
  }
}));
context.shiftSelectedFolderDrop = {
  items: shiftSelectedHandles.map((handle) => ({
    kind: "file",
    getAsFileSystemHandle() {
      if (!dragPermissionActive) throw new Error("drag permission expired");
      return Promise.resolve(handle);
    }
  }))
};
const shiftSelectionPromise = vm.runInContext("collectDroppedContent(shiftSelectedFolderDrop)", context);
dragPermissionActive = false;
const shiftSelection = await shiftSelectionPromise;
assert.deepEqual([...shiftSelection.folderSelection.roots], ["映像", "音楽", "資料"]);
assert.equal(shiftSelection.folderSelection.files.length, 3);

context.shiftSelectedVideoDrop = {
  items: ["a.mp4", "b.mp4", "c.mov"].map((name, index) => ({
    kind: "file",
    getAsFileSystemHandle() {
      return Promise.resolve({ kind: "file", name, async getFile() { return { name, size: index + 10, lastModified: 20 + index }; } });
    }
  })),
  files: []
};
const videoDrop = await vm.runInContext("collectDroppedContent(shiftSelectedVideoDrop)", context);
assert.equal(videoDrop.folderSelection, null);
assert.deepEqual([...videoDrop.looseFiles].map((file) => file.name), ["a.mp4", "b.mp4", "c.mov"]);

context.mixedDrop = {
  items: [firstHandle, { kind: "file", name: "cover.jpg", async getFile() { return { name: "cover.jpg", size: 8, lastModified: 30 }; } }]
    .map((handle) => ({ kind: "file", getAsFileSystemHandle() { return Promise.resolve(handle); } })),
  files: []
};
const mixedDrop = await vm.runInContext("collectDroppedContent(mixedDrop)", context);
assert.deepEqual([...mixedDrop.folderSelection.roots], ["音声"]);
assert.deepEqual([...mixedDrop.looseFiles].map((file) => file.name), ["cover.jpg"]);

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
assert.match(html, /id="folder-upload-password"[^>]*minlength="4"/);
assert.match(source, /openFolderUploadDialog\(selection, \{ append: \$\("#folder-upload-dialog"\)\.open \}\)/);
assert.match(source, /if \(!dialog\.open\) dialog\.showModal\(\)/);
assert.match(source, /folderUploadOperationSequence: 0/);
assert.match(source, /activeFolderUploadOperationId: null/);
const uploadStart = source.match(/async function uploadSelectedFolder\(event\) \{[\s\S]*?\n\}\n\nfunction waitForInterfacePaint/)?.[0] || "";
assert.ok(uploadStart.indexOf('submitButton.textContent = "準備中…"') < uploadStart.indexOf('$("#folder-upload-dialog").close()'));
assert.ok(uploadStart.indexOf('$("#folder-upload-dialog").close()') < uploadStart.indexOf("await waitForInterfacePaint()"));
assert.ok(uploadStart.indexOf("await waitForInterfacePaint()") < uploadStart.indexOf("await planFolderUpload"), "描画後にフォルダの差分確認を開始してください。");
assert.ok(uploadStart.indexOf("await planFolderUpload") < uploadStart.indexOf("await createEncryptedFolder"), "全差分を確認してからフォルダ作成を開始してください。");
assert.match(uploadStart, /const topLevelPassword = state\.folderId \? "" : \$\("#folder-upload-password"\)\.value/);
assert.match(uploadStart, /const folderPassword = !baseParentId && !folderPlan\.parentPath \? topLevelPassword : ""/);
assert.match(uploadStart, /state\.activeFolderUploadOperationId !== operationId/);
assert.match(source, /現在のアップロードが完了してから、もう一度お試しください/);
assert.match(source, /function waitForInterfacePaint\(\)[\s\S]*?requestAnimationFrame\(\(\) => requestAnimationFrame\(finish\)\)/);
assert.match(html, /id="download-folder-button"/);
assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.desktop-only \{ display: none !important; \}/);
assert.match(source, /collectFolderDownloads/);
assert.match(source, /downloadDisplayName/);

console.log("desktop folder upload and download: ok");
