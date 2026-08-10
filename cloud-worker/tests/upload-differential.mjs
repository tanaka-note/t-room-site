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
assert.notEqual(composed, changed, "同名でも容量が異なるデータはアップロード対象に残してください。");
const incomingGroups = vm.runInContext('findIncomingUploadConflictGroups([{ name: "same.mp4", size: 100 }, { name: "same.mp4", size: 100 }, { name: "same.mp4", size: 101 }])', context);
assert.equal(incomingGroups.length, 1, "同名・同容量の選択データだけを競合グループにしてください。");
assert.equal(incomingGroups[0].length, 2, "同名・同容量の選択データは片方を選ばず全件保留してください。");

const folderUpload = client.match(/async function uploadSelectedFolder\(event\) \{[\s\S]*?\n\}\n\nfunction waitForInterfacePaint/)?.[0] || "";
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
assert.match(client, /同名・同容量の保存済みデータがあります/);
assert.match(client, /findIncomingUploadConflictGroups/);
assert.match(client, /existingLocations: locations/);
assert.match(client, /renderUploadConflicts/);

assert.match(worker, /async function listUploadConflictCandidates/);
assert.match(worker, /f\.size_bytes IN \(\$\{sizePlaceholders\}\)/);
assert.match(worker, /WITH RECURSIVE folder_access/);
assert.match(worker, /is_allowed = 1 AND has_protected_ancestor = 1/);
assert.match(worker, /unlock\.session_id = \?/);
assert.match(worker, /CASE WHEN f\.crypto_version = 1 THEN '' ELSE f\.original_name END/);
assert.match(html, /id="upload-plan-summary"[^>]*hidden/);
assert.match(html, /id="upload-conflict-summary"[^>]*hidden/);

console.log("differential folder upload and failure paths: ok");
