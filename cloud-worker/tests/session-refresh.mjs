import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker, config] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
]);

assert.match(config, /"SESSION_TTL_SECONDS"\s*:\s*"2592000"/, "管理者のログイン期限が30日ではありません。");
assert.match(config, /"SUBADMIN_SESSION_TTL_SECONDS"\s*:\s*"2592000"/, "副管理者のログイン期限が30日ではありません。");
assert.match(config, /"SESSION_VERSION"\s*:\s*"5"/, "旧共通IDセッションを無効化する世代更新がありません。");
assert.match(worker, /Max-Age=\$\{maxAge\}/, "永続セッションCookieのMax-Ageがありません。");
assert.match(worker, /refreshAuthenticatedSession\(request, response, env, url, path\)/, "認証済みAPI利用時の期限更新がありません。");
assert.match(worker, /headers\.set\("Set-Cookie", sessionCookie\(token, maxAge/, "スライディング更新Cookieがありません。");
assert.match(worker, /clampNumber\(configured, 3600, 2592000, 2592000\)/, "セッション上限が30日に固定されていません。");
assert.match(worker, /sessionCacheId:\s*session\.sessionId/, "解除済み鍵をログインセッションへ関連付けていません。");
assert.match(client, /history\.state\?\.tcloud/, "再読み込み時のフォルダ履歴を復元していません。");
assert.doesNotMatch(client, /function initializeNavigationHistory\(\)\s*\{[\s\S]*?history\.replaceState\(\{ tcloud: true, folderId: null/, "再読み込み時に最上位を強制しています。");
assert.match(client, /await loadCachedFolderKeys\(\)/, "副管理者の解除済みフォルダ鍵を復元していません。");
assert.match(client, /await saveCachedFolderKey\(id, unlocked\.folderKey\)/, "フォルダ解除後の鍵をセッションへ保存していません。");
assert.match(client, /await clearCachedAdminKeys\(\)/, "ログアウト時に端末内の鍵を削除していません。");

console.log("persistent login and folder refresh restoration: ok");
