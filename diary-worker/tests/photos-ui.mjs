import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, css, script, worker, wrangler] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/wrangler.jsonc`, "utf8")
]);

assert.match(html, /id="camera-roll-button"/);
assert.match(html, /id="camera-roll-button"[^>]*aria-label="画像まとめ"[^>]*title="画像まとめ"/);
const filters = html.slice(html.indexOf('<div class="camera-roll-filters">'), html.indexOf('<p id="camera-roll-status"'));
const entrySearchIndex = filters.indexOf('id="photo-entry-search"');
const monthIndex = filters.indexOf('id="photo-month-filter"');
const fileNameIndex = filters.indexOf('id="photo-file-name-search"');
assert.ok(entrySearchIndex >= 0, "tag/content search must exist");
assert.ok(monthIndex > entrySearchIndex, "month must follow tag/content search");
assert.ok(fileNameIndex > monthIndex, "file-name search must follow month");
assert.match(filters, /タグ・内容検索/);
assert.match(filters, /タグ・日記名・本文/);
assert.match(filters, /ファイル名検索/);
assert.doesNotMatch(filters, /投稿者|photo-author-filter/);
assert.match(css, /\.camera-roll-filters\s*\{[\s\S]*?grid-template-columns:\s*minmax\(220px, 1\.5fr\) repeat\(2, minmax\(140px, 0\.6fr\)\)/);
assert.match(css, /\.camera-roll-filters\s*\{\s*grid-template-columns:\s*1fr 1fr;\s*\}/);
assert.match(css, /\.camera-roll-filters label:first-child\s*\{\s*grid-column:\s*1 \/ -1;/);
assert.match(html, /id="photo-input"[^>]*accept="image\/\*"[^>]*multiple/);
assert.match(html, /id="photo-drop-zone"[^>]*role="button"/);
assert.match(html, /画像をここへドラッグ＆ドロップ/);
assert.match(html, /元画質で保存/);
assert.match(html, /低画質で保存/);
assert.match(script, /resizePhoto\(bitmap, 1800, 320 \* 1024/);
assert.match(script, /\["dragenter", "dragover", "dragleave", "drop"\]/);
assert.match(script, /prepareSelectedPhotos\(\[\.\.\.\(event\.dataTransfer\?\.files \|\| \[\]\)\], getEditorSelectionOffset\("end"\)\)/);
assert.match(script, /String\(file\.type\)\.startsWith\("image\/"\)/);
assert.match(script, /state\.editorPhotos = \(entry\?\.photos \|\| \[\]\)\.map/);
assert.match(script, /previewUrl: URL\.createObjectURL\(thumbnailBlob\)/);
assert.match(script, /image\.src = photo\.thumbnailUrl \|\| photo\.previewUrl/);
assert.match(script, /remove\.textContent = photo\.existing \? "削除" : "取り除く"/);
assert.match(script, /state\.editorDeletedPhotoIds\.add\(photo\.id\)/);
assert.match(script, /method: "DELETE"/);
assert.match(script, /\[\[写真:/);
assert.match(script, /openPhotoViewer/);
assert.match(script, /state\.photoEntryQuery/);
assert.match(script, /state\.photoFileNameQuery/);
assert.match(script, /parameters\.set\("entryQuery", state\.photoEntryQuery\)/);
assert.match(script, /parameters\.set\("fileName", state\.photoFileNameQuery\)/);
assert.doesNotMatch(script, /photoAuthorFilter|state\.photoAuthor|parameters\.set\("author"/);
assert.match(script, /camera-roll-date/);
assert.match(script, /camera-roll-title/);
assert.match(script, /function handleCameraRollClick\(event\)[\s\S]*?openPhotoViewer\(state\.photos, index\)/);
assert.doesNotMatch(script, /elements\.cameraRollDialog\.close\(\);\s*openEntry\(photo\.entryId\);/s);
assert.match(worker, /diary_photos|uploadEntryPhoto/);
assert.match(worker, /url\.searchParams\.get\("entryQuery"\)/);
assert.match(worker, /url\.searchParams\.get\("fileName"\)/);
assert.match(worker, /EXISTS \(\s*SELECT 1 FROM diary_tags photo_tag/s);
assert.match(worker, /instr\(p\.file_name, \?\) > 0/);
assert.doesNotMatch(worker, /url\.searchParams\.get\("author"\)/);
assert.doesNotMatch(worker, /authors: authors\.results/);
assert.match(worker, /async function deleteEntryPhoto/);
assert.match(worker, /env\.MEDIA\.delete\(\[row\.original_key, row\.display_key, row\.thumbnail_key\]\)/);
assert.match(worker, /img-src 'self' data: blob:/);
assert.match(wrangler, /t-room-diary-media/);

process.stdout.write("Diary camera roll UI contract test passed.\n");
