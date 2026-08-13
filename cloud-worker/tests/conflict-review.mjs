import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker, html, css] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8")
]);

for (const id of ["conflict-dialog", "conflict-group-list", "conflict-file-list", "conflict-groups-back"]) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} がありません。`);
}
assert.doesNotMatch(html, /id="(?:floating-)?conflict-count-button"/, "競合確認の進捗を並び替え欄へ表示しないでください。");
assert.match(html, /data-view="conflicts"><span aria-hidden="true">⚠<\/span>競合<\/button>/, "履歴欄が⚠の競合メニューへ変わっていません。");
assert.doesNotMatch(html, /data-view="history"/, "操作履歴メニューを表示しないでください。");
assert.match(css, /\.file-card \.conflict-badge \{[^}]*top: 9px;[^}]*right: 47px;/);
assert.match(client, /if \(!state\.listMode && conflictGroupId && !file\.trashed\)/);
assert.match(client, /badge\.textContent = "競合"/);
assert.match(client, /function syncVisibleConflictBadges\(\)/);
assert.match(client, /function openConflictGroupList\(\)/);
assert.match(client, /function renderConflictGroupList\(\)/);
assert.match(client, /function openConflictGroup\(groupId\)/);
assert.match(client, /\$\("#conflict-file-list"\)\.hidden = true/);
assert.match(client, /\$\("#conflict-group-list"\)\.hidden = true/);
assert.match(client, /for \(const file of group\.files\) list\.append\(conflictFileRow\(file\)\)/);
assert.match(client, /function deleteConflictFile\(file\)/);
assert.match(client, /function editConflictFile\(file\)/);
assert.match(client, /requestIdleCallback/);
assert.match(client, /state\.conflictScanCompleted/);
assert.match(client, /loadUploadConflictCandidates\(state\.files\.map/);
assert.match(client, /visibleIdentities\.has\(uploadFileIdentity/);
assert.match(client, /generation !== state\.conflictScanGeneration/);
assert.match(client, /async function loadConflictOverview\(\)/);
assert.match(client, /function buildConflictGroups\(files, folders/);
assert.match(worker, /FROM cloud_files/, "競合判定はファイルだけを対象にしてください。");
assert.match(client, /const CONFLICT_CATEGORY_ORDER = \["audio", "video", "other"\]/);
assert.match(client, /audio: \{ label: "音楽", symbol: "♪" \}/);
assert.match(client, /video: \{ label: "動画", symbol: "▶" \}/);
assert.match(client, /other: \{ label: "その他", symbol: "□" \}/);
assert.match(client, /appendConflictCategoryList\(list, groups\)/);
assert.match(client, /appendConflictCategoryList\(list, groups, "h4"\)/);
assert.match(css, /\.conflict-category-heading/);
assert.match(client, /const topFolderId = Number\(file\.topFolderId/);
assert.match(client, /nearSize && \(sameName \|\| sameTimestamp\)/);
assert.match(client, /PWを解除したトップフォルダ内に、競合候補はありません/);
assert.match(client, /競合データ \$\{groups\.length\.toLocaleString/);
assert.match(client, /競合ではないファイルが表示された場合は、T-Cloud管理者へお知らせください。/);
assert.match(client, /\.normalize\("NFKC"\)[\s\S]*?\.trim\(\)[\s\S]*?toLocaleLowerCase\("ja"\)/);

const scanBody = client.match(/async function scanStoredConflicts\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(scanBody, /method:\s*"(?:DELETE|PATCH)"/, "競合確認中に自動削除・自動名称変更を行わないでください。");

assert.match(worker, /path === "\/api\/conflicts"/);
assert.match(worker, /async function listStoredConflictCandidates/);
assert.match(worker, /folder_scope\(id, top_folder_id\)/);
assert.match(worker, /scope\.top_folder_id AS topFolderId/);
assert.match(worker, /folderId = optionalId\(body\.folderId\)/, "アップロード前判定は実際の保存先フォルダを指定してください。");
assert.match(client, /folderId: exactFolderId/, "アップロード前判定へ実際の保存先フォルダを送信してください。");
assert.match(worker, /WITH RECURSIVE folder_access/);
assert.match(worker, /access\.is_allowed = 1 AND access\.has_protected_ancestor = 1/);
assert.match(html, /cloud\.css\?v=20260813-2/);
assert.match(html, /cloud\.js\?v=20260813-4/);

console.log("stored conflict badges and grouped review: ok");
