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
assert.match(html, /id="photo-input"[^>]*accept="image\/\*"[^>]*multiple/);
assert.match(html, /元画質で保存/);
assert.match(html, /低画質で保存/);
assert.match(script, /resizePhoto\(bitmap, 1800, 320 \* 1024/);
assert.match(script, /\[\[写真:/);
assert.match(script, /openPhotoViewer/);
assert.match(worker, /diary_photos|uploadEntryPhoto/);
assert.match(wrangler, /t-room-diary-media/);

process.stdout.write("Diary camera roll UI contract test passed.\n");
