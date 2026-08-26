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
assert.match(html, /id="tag-directory-link"[^>]*href="\/diary\/tags\/"/);
assert.match(html, /id="tag-more-button"[^>]*href="\/diary\/tags\/"[^>]*>もっと見る<\/a>/);
assert.match(html, /id="tag-page-back"[^>]*href="\/diary\/"/);
assert.match(html, /id="diary-search-panel"/);
assert.match(html, /id="entry-tag-suggestions"[^>]*role="listbox"/);
assert.match(html, /id="entry-tags"[^>]*aria-autocomplete="list"/);
assert.match(script, /Number\(right\.count \|\| 0\) - Number\(left\.count \|\| 0\)/);
assert.match(script, /new Intl\.Collator\(\["ja-JP", "en-US"\]/);
assert.match(script, /tagCollator\.compare\(tagSortKey\(left\.value\), tagSortKey\(right\.value\)\)/);
assert.match(script, /replace\(\/\[ァ-ヶ\]\/g/);
assert.match(script, /numeric: true/);
assert.match(script, /applyRouteState\(\)/);
assert.match(script, /\/diary\\\/tag\\\/\(\[\^\/\]\+\)/);
assert.match(script, /#\$\{tag\}の日記一覧/);
assert.match(script, /createTagLink\(tag, `#\$\{tag\}`\)/);
assert.match(script, /elements\.tagList\.replaceChildren\(\.\.\.sortedTags\.map/);
assert.match(script, /elements\.tagMore\.hidden = state\.tagDirectory/);
assert.match(script, /onTagDirectory \? "タグ一覧" : "日記"/);
assert.match(script, /function renderEntryTagSuggestions\(\)/);
assert.match(script, /currentEntryTagContext\(\)/);
assert.match(script, /replace\(\/\^#\+\//);
assert.match(script, /!query \|\| normalizeTagForMatch\(item\.value\)\.startsWith\(query\)/);
assert.match(script, /Number\(right\.count \|\| 0\) - Number\(left\.count \|\| 0\)/);
assert.doesNotMatch(script, /\.slice\(0,\s*6\)/);
assert.match(script, /setRangeText\(tag, context\.start, context\.end, "end"\)/);
assert.match(script, /\["ArrowDown", "ArrowUp", "Enter", "Escape"\]/);
assert.match(script, /scrollIntoView\(\{ block: "nearest" \}\)/);
assert.match(script, /href = `\$\{BASE_PATH\}\/tag\/\$\{encodeURIComponent\(tag\)\}\//);
assert.match(style, /\.diary-tag-cloud \{[^}]*max-height:[^}]*overflow-y: auto;/s);
assert.match(style, /overscroll-behavior-y: auto/);
assert.match(style, /\.tag-directory-link \{/);
assert.match(style, /\.tag-more-button \{/);
assert.match(style, /\.entry-tag-suggestions \{[^}]*position: fixed;[^}]*overflow-y: auto;[^}]*max-height: 246px;/s);
assert.match(script, /function positionEntryTagSuggestions\(\)/);
assert.match(script, /window\.visualViewport/);
assert.match(script, /availableBelow/);
assert.match(script, /availableAbove/);
assert.match(script, /elements\.editorDialog\.addEventListener\("scroll", positionEntryTagSuggestions/);
assert.match(worker, /ORDER BY count DESC, dt\.tag ASC/);
assert.match(worker, /path\.startsWith\("\/tag\/"\)/);
assert.match(worker, /path === "\/tags\/"/);

process.stdout.write("Diary tag ordering and scrolling contract test passed.\n");
