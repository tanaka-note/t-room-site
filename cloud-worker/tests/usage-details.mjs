import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker, html] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8")
]);

assert.match(worker, /path === "\/api\/usage-details"[\s\S]*?getUsageDetails/);
assert.match(worker, /async function getUsageDetails[\s\S]*?requireAdmin\(session\)/, "フォルダ別容量の管理者権限確認がありません。");
assert.match(worker, /WITH RECURSIVE folder_tree\(root_id, id\)/, "最上位フォルダ別の再帰集計がありません。");
assert.match(worker, /folderId && session\.role === "subadmin"[\s\S]*?totalFileCount[\s\S]*?totalSizeBytes/, "副管理者向けフォルダ総量集計がありません。");
assert.match(client, /showUnlockedTotals[\s\S]*?総ファイル数：[\s\S]*?総容量：/, "解除済みフォルダの総量表示がありません。");
assert.match(html, /id="usage-details-button"[\s\S]*?>詳細</);
assert.match(html, /id="usage-details-dialog"/);

console.log("subadmin unlocked totals and admin usage details: ok");
