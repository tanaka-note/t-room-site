import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, style, worker] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8")
]);

assert.match(html, /id="tag-list"[^>]*tabindex="0"/);
assert.match(html, /id="tag-page-back"[^>]*href="\/diary\/"/);
assert.match(html, /id="diary-search-panel"/);
assert.match(script, /Number\(right\.count \|\| 0\) - Number\(left\.count \|\| 0\)/);
assert.match(script, /new Intl\.Collator\(\["ja-JP", "en-US"\]/);
assert.match(script, /tagCollator\.compare\(tagSortKey\(left\.value\), tagSortKey\(right\.value\)\)/);
assert.match(script, /replace\(\/\[ァ-ヶ\]\/g/);
assert.match(script, /numeric: true/);
assert.match(script, /applyRouteState\(\)/);
assert.match(script, /\/diary\\\/tag\\\/\(\[\^\/\]\+\)/);
assert.match(script, /#\$\{tag\}の記事一覧/);
assert.match(script, /createTagLink\(tag, `#\$\{tag\}`\)/);
assert.match(script, /href = `\$\{BASE_PATH\}\/tag\/\$\{encodeURIComponent\(tag\)\}\//);
assert.match(style, /\.diary-tag-cloud \{[^}]*max-height:[^}]*overflow-y: auto;/s);
assert.match(style, /overscroll-behavior-y: auto/);
assert.match(worker, /ORDER BY count DESC, dt\.tag ASC/);
assert.match(worker, /path\.startsWith\("\/tag\/"\)/);

process.stdout.write("Diary tag ordering and scrolling contract test passed.\n");
