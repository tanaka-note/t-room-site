import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, css, script, worker, wrangler, stagingMigration] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/wrangler.jsonc`, "utf8"),
  readFile(`${root}/migrations/0015_photo_upload_staging.sql`, "utf8")
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
assert.match(css, /\.icon-button\s*\{[\s\S]*?background:\s*#fff;[\s\S]*?color:\s*var\(--ink\);/);
assert.match(css, /\.photo-viewer-close\s*\{[\s\S]*?background:\s*rgba\(0, 0, 0, 0\.42\);[\s\S]*?color:\s*#fff;/);
assert.match(css, /\.photo-viewer-close:hover,\s*\.photo-viewer-close:focus-visible\s*\{[\s\S]*?background:\s*rgba\(255, 255, 255, 0\.14\);[\s\S]*?color:\s*#fff;/);
assert.match(html, /id="photo-input"[^>]*accept="image\/\*"[^>]*multiple/);
assert.match(html, /id="photo-drop-zone"[^>]*role="button"/);
assert.match(html, /画像をここへドラッグ＆ドロップ/);
assert.match(html, /元画質で保存/);
assert.match(html, /低画質で保存/);
assert.match(script, /resizePhoto\(bitmap, 1800, 320 \* 1024/);
assert.match(script, /\["dragenter", "dragover", "dragleave", "drop"\]/);
assert.match(script, /prepareSelectedPhotos\(\[\.\.\.\(event\.dataTransfer\?\.files \|\| \[\]\)\], getEditorSelectionOffset\("end"\)\)/);
assert.match(script, /photoPreparationPromise: null/);
assert.match(script, /photoUploading: false/);
assert.match(script, /PHOTO_UPLOAD_CONCURRENCY = 2/);
assert.match(script, /queueBackgroundPhotoUpload\(photo\)/,
  "each prepared photo must be queued before posting");
assert.match(script, /\/api\/photo-upload-sessions/);
assert.match(script, /await ensurePhotosUploaded\(pendingPhotos\)/,
  "posting must wait for any remaining staged uploads");
assert.match(script, /commitStagedPhotos\(saved\.entry\.id, pendingPhotos\)/,
  "posting must promote staged photos without uploading them again");
assert.match(script, /await waitForPhotoPreparation\(\);\s*const id = Number\(elements\.entryId\.value/s,
  "entry serialization must wait for the active photo preparation task");
assert.match(script, /PHOTO_UPLOAD_RETRY_DELAYS_MS = Object\.freeze\(\[250, 750\]\)/);
assert.match(script, /response\.status < 500 \|\| response\.status > 599/,
  "only network failures, invalid success responses, and 5xx responses may be retried");
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
assert.match(worker, /diary_photo_upload_sessions|uploadStagedPhoto/);
assert.match(worker, /diary_staged_photos|commitPhotoUploadSession/);
assert.match(worker, /runScheduledStagedPhotoCleanup/);
assert.match(worker, /function existingPhotoUploadResponse\(row, expected\)/);
assert.match(worker, /Number\(row\.entry_id\) === Number\(expected\.entryId\)/);
assert.match(worker, /String\(row\.household_id\) === String\(expected\.householdId\)/);
assert.match(worker, /String\(row\.created_by_id\) === String\(expected\.createdById\)/);
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
assert.match(stagingMigration, /CREATE TABLE IF NOT EXISTS diary_photo_upload_sessions/);
assert.match(stagingMigration, /CREATE TABLE IF NOT EXISTS diary_staged_photos/);
assert.match(stagingMigration, /FOREIGN KEY \(upload_session_id\).*ON DELETE CASCADE/);
assert.match(stagingMigration, /CREATE TRIGGER diary_validate_photo_upload_session_commit/);
assert.match(stagingMigration, /json_each\(NEW\.committed_photo_ids\)/);

process.stdout.write("Diary camera roll UI contract test passed.\n");
