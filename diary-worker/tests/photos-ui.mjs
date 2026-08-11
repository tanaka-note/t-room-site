import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, worker, wrangler] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/wrangler.jsonc`, "utf8")
]);

assert.match(html, /id="camera-roll-button"/);
assert.match(html, /id="camera-roll-button"[^>]*>画像まとめ<\/button>/);
assert.match(html, /id="photo-input"[^>]*accept="image\/\*"[^>]*multiple/);
assert.match(html, /id="photo-drop-zone"[^>]*role="button"/);
assert.match(html, /画像をここへドラッグ＆ドロップ/);
assert.match(html, /元画質で保存/);
assert.match(html, /低画質で保存/);
assert.match(script, /resizePhoto\(bitmap, 1800, 320 \* 1024/);
assert.match(script, /\["dragenter", "dragover", "dragleave", "drop"\]/);
assert.match(script, /prepareSelectedPhotos\(\[\.\.\.\(event\.dataTransfer\?\.files \|\| \[\]\)\]\)/);
assert.match(script, /String\(file\.type\)\.startsWith\("image\/"\)/);
assert.match(script, /state\.editorPhotos = \(entry\?\.photos \|\| \[\]\)\.map/);
assert.match(script, /\[\[写真:/);
assert.match(script, /openPhotoViewer/);
assert.match(script, /camera-roll-date/);
assert.match(script, /camera-roll-title/);
assert.match(script, /elements\.cameraRollDialog\.close\(\);\s*openEntry\(photo\.entryId\);/s);
assert.doesNotMatch(script, /openPhotoViewer\(state\.photos/);
assert.match(worker, /diary_photos|uploadEntryPhoto/);
assert.match(wrangler, /t-room-diary-media/);

process.stdout.write("Diary camera roll UI contract test passed.\n");
