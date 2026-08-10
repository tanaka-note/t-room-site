import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  TCloudMedia: { safeFilename: (value) => String(value || "download") }
});
vm.runInContext(client, context);

const composed = vm.runInContext('uploadFileIdentity("é.jpg", 1024, 1234)', context);
const decomposed = vm.runInContext('uploadFileIdentity("é.jpg", 1024, 1234)', context);
const changed = vm.runInContext('uploadFileIdentity("é.jpg", 1024, 5678)', context);
assert.equal(composed, decomposed, "Unicode表記が異なる同じファイル名を同一視してください。");
assert.notEqual(composed, changed, "更新日時が異なるデータは誤ってスキップしないでください。");

const folderUpload = client.match(/async function uploadSelectedFolder\(event\) \{[\s\S]*?\n\}\n\nfunction waitForInterfacePaint/)?.[0] || "";
assert.match(folderUpload, /findOrCreateUploadFolder/);
assert.match(folderUpload, /displayName: record\.relativePath/);
assert.match(folderUpload, /skipExisting: true/);
assert.doesNotMatch(folderUpload, /await createEncryptedFolder\(parts\.at\(-1\)/);

assert.match(client, /async function excludeExistingUploadFiles/);
assert.match(client, /保存済みデータを確認中/);
assert.match(client, /差分アップロード完了/);
assert.match(client, /displayName \|\| file\.downloadDisplayName \|\| file\.name/);
assert.match(client, /復号できない既存データは誤ってスキップせず/);

assert.match(worker, /const uploadIndex = url\.searchParams\.get\("uploadIndex"\) === "1"/);
assert.match(worker, /LIMIT \$\{uploadIndex \? uploadPageSize \+ 1 : uploadPageSize\} OFFSET \$\{uploadOffset\}/);
assert.match(worker, /nextFileOffset/);

console.log("differential folder upload and failure paths: ok");
