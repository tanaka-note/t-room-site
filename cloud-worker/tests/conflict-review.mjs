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
assert.match(client, /\.normalize\("NFKC"\)[\s\S]*?\.trim\(\)[\s\S]*?toLocaleLowerCase\("ja"\)/);

const scanBody = client.match(/async function scanStoredConflicts\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(scanBody, /method:\s*"(?:DELETE|PATCH)"/, "競合確認中に自動削除・自動名称変更を行わないでください。");

assert.match(worker, /path === "\/api\/conflicts"/);
assert.match(worker, /async function listStoredConflictCandidates/);
assert.match(worker, /GROUP BY size_bytes HAVING COUNT\(\*\) > 1/);
assert.match(worker, /WITH RECURSIVE folder_access/);
assert.match(worker, /access\.is_allowed = 1 AND access\.has_protected_ancestor = 1/);
assert.match(html, /cloud\.js\?v=20260810-99/);

console.log("stored conflict badges and grouped review: ok");
