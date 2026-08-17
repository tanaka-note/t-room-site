import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, style, worker, migration, twaManifest] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/migrations/0012_entry_drafts.sql`, "utf8"),
  readFile(`${root}/../android-diary-twa/app/src/main/AndroidManifest.xml`, "utf8")
]);

for (const id of ["camera-roll-button", "draft-button", "trash-button", "new-entry-button", "logout-button"]) {
  assert.match(html, new RegExp(`id="${id}"[^>]*aria-label="[^"]+"[^>]*title="[^"]+"`));
}
assert.match(html, /id="draft-count"[^>]*class="header-icon-badge"/);
assert.match(html, /id="new-entry-button"[^>]*class="header-icon-button is-create"/);
assert.match(html, /id="logout-button"[^>]*class="header-icon-button is-logout"/);
assert.match(script, /function setBusyIconButton\(/);
assert.match(script, /setBusyIconButton\(elements\.logoutButton,\s*true,\s*"ログアウト処理中",\s*"ログアウト"\);/);
assert.match(script, /setBusyIconButton\(elements\.logoutButton,\s*false,[\s\S]*?"ログアウト"\);/);
assert.doesNotMatch(script, /setBusy\(elements\.logoutButton,\s*true,\s*"[^"]*"\)/);
assert.doesNotMatch(script, /setBusy\(elements\.logoutButton,\s*false,\s*"[^"]*"\)/);
assert.match(style, /\.header-icon-button:focus-visible/);
assert.match(style, /\.header-icon-button\.is-create/);
assert.match(style, /\.header-icon-button\.is-create\s*\{[\s\S]*?flex:\s*0 0 88px;[\s\S]*?width:\s*88px;/);
assert.match(style, /@media \(max-width: 680px\)[\s\S]*?\.header-actions \.header-icon-button\.is-create\s*\{[\s\S]*?flex:\s*0 0 88px;[\s\S]*?width:\s*88px;/);
assert.match(style, /@media \(max-width: 430px\)[\s\S]*?\.header-actions \.header-icon-button\.is-create\s*\{[\s\S]*?flex-basis:\s*85px;[\s\S]*?width:\s*85px;/);
assert.match(style, /\.header-icon-button svg\s*\{[\s\S]*?width:\s*21px;[\s\S]*?height:\s*21px;/);
assert.match(style, /\.header-icon-button\.is-logout/);
assert.match(style, /@media \(max-width: 680px\)[\s\S]*?\.header-actions \{[\s\S]*?overflow-x: auto;/);

assert.match(html, /id="save-draft-button"[^>]*>下書き保存<\/button>/);
assert.match(html, /id="save-entry-button"[^>]*>投稿<\/button>/);
assert.match(html, /id="editor-leave-dialog"/);
for (const id of ["editor-leave-cancel", "editor-leave-discard", "editor-leave-save-draft"]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.doesNotMatch(script, /入力中の内容を破棄しますか/);
assert.match(script, /function requestEditorClose\(\)/);
assert.match(script, /function saveEntryAsDraft/);
assert.match(script, /function pushEditorHistory\(\)/);
assert.match(script, /\[EDITOR_HISTORY_KEY\]: token/);
assert.match(script, /if \(state\.drafts\) parameters\.set\("draft", "1"\)/);
assert.match(script, /if \(state\.drafts\) openDraft/);
assert.match(script, /無題の下書き/);
assert.match(script, /最終編集：/);

assert.match(worker, /draft \? "e\.status = 'draft'" : "e\.status = 'published'"/);
assert.match(worker, /ORDER BY \$\{draft \? "e\.updated_at DESC, e\.id DESC"/);
assert.match(worker, /e\.status = 'published'/);
assert.match(worker, /savePublishedEditDraft/);
assert.match(worker, /publishEditDraft/);
assert.match(worker, /draftCount/);
assert.match(migration, /ADD COLUMN status TEXT NOT NULL DEFAULT 'published'/);
assert.match(migration, /draft_of_entry_id/);
assert.match(migration, /idx_diary_entries_single_edit_draft/);

assert.match(twaManifest, /https:\/\/tanaka-note\.com\/diary\/\?source=twa/);
assert.match(twaManifest, /com\.google\.androidbrowserhelper\.trusted\.LauncherActivity/);

process.stdout.write("Diary draft UI, header accessibility, and TWA contract test passed.\n");
