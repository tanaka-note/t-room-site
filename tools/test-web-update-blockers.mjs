import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workspace } from "./web-app-registry.mjs";

const [diary, billing, cloud, share] = await Promise.all([
  readFile(resolve(workspace, "diary-worker/public/diary.js"), "utf8"),
  readFile(resolve(workspace, "billing-worker/public/billing.js"), "utf8"),
  readFile(resolve(workspace, "cloud-worker/public/cloud.js"), "utf8"),
  readFile(resolve(workspace, "cloud-worker/public/share.js"), "utf8")
]);

for (const state of ["editorDirty", "editorComposing", "photoPreparing", "photoPickerActive"]) {
  assert.match(diary, new RegExp(`troom:before-auto-update[\\s\\S]{0,500}state\\.${state}`), `日記の${state}を保護してください`);
}
assert.match(diary, /troom:before-auto-update[\s\S]{0,600}dialog\[open\]/);

assert.match(billing, /troom:before-auto-update[\s\S]{0,300}dialog\[open\]/, "請求書の入力ダイアログを保護してください");

for (const state of ["uploading", "activeFolderUploadOperationId", "downloadActive", "offlineActive", "pendingSafetyUpload", "filePickerActive"]) {
  assert.match(cloud, new RegExp(`troom:before-auto-update[\\s\\S]{0,700}state\\.${state}`), `T-Cloudの${state}を保護してください`);
}
assert.match(cloud, /filePickerActive = true[\s\S]{0,500}finishFilePickerInteraction/);
assert.match(cloud, /troom:auto-update-ready/);
assert.match(share, /troom:before-auto-update[\s\S]{0,300}state\.downloadActive/, "共有ダウンロード中を保護してください");

process.stdout.write("日記・請求書・T-Cloudの未保存／転送中更新ブロッカーを確認しました。\n");
