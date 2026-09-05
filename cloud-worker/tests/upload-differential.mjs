import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, worker, html] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8")
]);

const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  TCloudMedia: { safeFilename: (value) => String(value || "download") }
});
vm.runInContext(client, context);

const composed = vm.runInContext('uploadFileIdentity("é.jpg", 1024)', context);
const decomposed = vm.runInContext('uploadFileIdentity("é.jpg", 1024)', context);
const changed = vm.runInContext('uploadFileIdentity("é.jpg", 2048)', context);
assert.equal(composed, decomposed, "Unicode表記が異なる同じファイル名を同一視してください。");
const visualVariant = vm.runInContext('uploadFileIdentity("  ＶＩＤＥＯ 01.MP4  ", 1024)', context);
const normalizedVariant = vm.runInContext('uploadFileIdentity("video 01.mp4", 1024)', context);
assert.equal(visualVariant, normalizedVariant, "全角半角・大文字小文字・前後空白が違う同名ファイルを競合候補として扱ってください。");
assert.notEqual(composed, changed, "同名でも容量が異なるデータはアップロード対象に残してください。");
const incomingGroups = vm.runInContext('findIncomingUploadConflictGroups([{ name: "same.mp4", size: 100 }, { name: "same.mp4", size: 100 }, { name: "same.mp4", size: 101 }])', context);
assert.equal(incomingGroups.length, 1, "同名・同容量の選択データだけを競合グループにしてください。");
assert.equal(incomingGroups[0].length, 2, "同名・同容量の選択データは片方を選ばず全件保留してください。");
const separateFolders = vm.runInContext(`(() => {
  const left = { name: "same.mp4", size: 100 };
  const right = { name: "same.mp4", size: 100 };
  const destinations = new Map([[left, { displayName: "folder-a/same.mp4" }], [right, { displayName: "folder-b/same.mp4" }]]);
  return findIncomingUploadConflictGroups([left, right], destinations);
})()`, context);
assert.equal(separateFolders.length, 0, "別フォルダへ保存する同名・同容量データは、アップロード時の競合にしないでください。");
const sameRelativeFolder = vm.runInContext(`(() => {
  const left = { name: "same.mp4", size: 100 };
  const right = { name: "same.mp4", size: 100 };
  const destinations = new Map([[left, { displayName: "folder-a/same.mp4" }], [right, { displayName: "folder-a/same.mp4" }]]);
  return findIncomingUploadConflictGroups([left, right], destinations);
})()`, context);
assert.equal(sameRelativeFolder.length, 1, "同じ相対パスへ保存する同名・同容量データは、アップロード時の競合にしてください。");

const folderUpload = client.match(/async function uploadSelectedFolder\(event\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction waitForInterfacePaint/)?.[0] || "";
assert.match(folderUpload, /planFolderUpload/);
assert.ok(folderUpload.indexOf("await planFolderUpload") < folderUpload.indexOf("await createEncryptedFolder"), "ファイル・フォルダの全差分確認を保存開始前に完了してください。");
assert.match(folderUpload, /displayName: record\.relativePath/);
assert.match(folderUpload, /skipExisting: false,[\s\S]*?precheckedSkipped: plan\.duplicateSkipped/);
assert.doesNotMatch(folderUpload, /await createEncryptedFolder\(parts\.at\(-1\)/);

assert.match(client, /async function excludeExistingUploadFiles/);
assert.match(client, /async function planFolderUpload/);
assert.match(client, /\/upload-conflict-candidates/);
assert.match(client, /if \(options\.skipExisting !== false && files\.length\)/);
assert.match(client, /const precheckedSkipped = Array\.isArray\(options\.precheckedSkipped\)/);
assert.match(client, /showUploadPlanSummary\(options\.newFolderCount, total, options\.reusedFolderCount, duplicateSkipped\.length, skippedFiles\.length\)/);
assert.match(client, /差分確認：\$\{added\}／\$\{existing\}/);
assert.match(client, /競合候補を確認中/);
assert.match(client, /差分アップロード完了/);
assert.match(client, /displayName \|\| file\.downloadDisplayName \|\| file\.name/);
assert.match(client, /復号できない既存データは誤って保留せず/);
assert.match(client, /今回選択したデータ内に同名・同容量のファイルがあります/);
assert.match(client, /同じ保存先に、同名・同容量の保存済みデータがあります/);
assert.match(client, /findIncomingUploadConflictGroups/);
assert.match(client, /incomingUploadRelativeFolder/);
assert.match(client, /destinations\?\.get\(file\)\?\.folderId \?\? state\.folderId/);
assert.match(client, /existingLocations: locations/);
assert.match(client, /renderUploadConflicts/);

assert.match(worker, /async function listUploadConflictCandidates/);
assert.match(worker, /f\.size_bytes IN \(\$\{sizePlaceholders\}\)/);
const uploadCandidateRoute = worker.match(/async function listUploadConflictCandidates[\s\S]*?\n\}/)?.[0] || "";
assert.match(uploadCandidateRoute, /WHERE f\.folder_id = \?/, "保存済みデータは実際の保存先フォルダ内だけを照合してください。");
assert.doesNotMatch(uploadCandidateRoute, /WITH RECURSIVE/, "アップロード前判定で別フォルダを横断しないでください。");
const storedConflictRoute = worker.match(/async function listStoredConflictCandidates[\s\S]*?\n\}/)?.[0] || "";
assert.match(storedConflictRoute, /WITH RECURSIVE folder_scope/, "既存の競合一覧のフォルダ横断処理は変更しないでください。");
assert.match(worker, /CASE WHEN f\.crypto_version = 1 THEN '' ELSE f\.original_name END/);
assert.match(html, /id="upload-plan-summary"[^>]*hidden/);
assert.match(html, /id="upload-conflict-summary"[^>]*hidden/);

console.log("differential folder upload and failure paths: ok");
