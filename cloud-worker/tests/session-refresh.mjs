import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker, config] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
]);

assert.match(config, /"SESSION_TTL_SECONDS"\s*:\s*"2592000"/, "ログイン期限が30日ではありません。");
assert.match(worker, /Max-Age=\$\{maxAge\}/, "永続セッションCookieのMax-Ageがありません。");
assert.match(worker, /sessionCacheId:\s*session\.sessionId/, "解除済み鍵をログインセッションへ関連付けていません。");
assert.match(client, /history\.state\?\.tcloud/, "再読み込み時のフォルダ履歴を復元していません。");
assert.doesNotMatch(client, /function initializeNavigationHistory\(\)\s*\{[\s\S]*?history\.replaceState\(\{ tcloud: true, folderId: null/, "再読み込み時に最上位を強制しています。");
assert.match(client, /await loadCachedFolderKeys\(\)/, "副管理者の解除済みフォルダ鍵を復元していません。");
assert.match(client, /await saveCachedFolderKey\(id, unlocked\.folderKey\)/, "フォルダ解除後の鍵をセッションへ保存していません。");
assert.match(client, /await clearCachedAdminKeys\(\)/, "ログアウト時に端末内の鍵を削除していません。");

console.log("persistent login and folder refresh restoration: ok");
