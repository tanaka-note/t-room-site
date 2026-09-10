import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, style, worker] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8")
]);

assert.match(html, /id="tag-list"[^>]*tabindex="0"/);
assert.match(html, /id="tag-directory-link"[^>]*href="\/diary\/tags\/"/);
assert.match(html, /class="tag-panel-actions">\s*<span id="tag-total-count"[^>]*aria-live="polite">タグ数 0<\/span>\s*<a id="tag-directory-link"[^>]*href="\/diary\/tags\/"/);
assert.match(script, /tagTotalCount: document\.querySelector\("#tag-total-count"\)/);
assert.match(script, /elements\.tagTotalCount\.textContent = `タグ数 \$\{state\.availableTags\.length\}`/);
assert.doesNotMatch(script, /tagTotalCount\.textContent[^;]*filteredTags\.length/);
assert.match(style, /\.tag-panel-actions \{[^}]*display: flex;[^}]*align-items: center;[^}]*flex: 0 0 auto;[^}]*margin-left: auto;/s);
assert.match(style, /\.tag-total-count \{[^}]*color: var\(--muted\);[^}]*white-space: nowrap;/s);
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
assert.match(worker, /INSERT INTO diary_tags \(entry_id, tag, sort_order\)/);
assert.match(worker, /ORDER BY dt\.sort_order ASC, dt\.rowid ASC/);
assert.match(script, /orderedStringList\(entry\.tags\) === orderedStringList\(payload\.tags\)/);
assert.match(worker, /path\.startsWith\("\/tag\/"\)/);
assert.match(worker, /path === "\/tags\/"/);

// Run the actual renderer with a small DOM substitute: totals follow complete
// meta results, including the early return for empty/no-match tag searches.
const renderSource = script.slice(script.indexOf("  function renderTags(tags) {"), script.indexOf("  function renderEntryTagSuggestions()"));
const state = { availableTags: [], tagQuery: "", tagDirectory: false };
const elements = {
  tagTotalCount: { textContent: "" },
  tagList: { replaceChildren(...items) { this.items = items; } },
  tagMore: { hidden: false }
};
const context = vm.createContext({
  state, elements, tagCollator: new Intl.Collator("ja-JP"),
  tagSortKey: (value) => value,
  createTagLink: (value, label) => ({ value, label, setAttribute() {} }),
  createEmpty: (text) => ({ text })
});
vm.runInContext(renderSource, context);
const tags = [{ value: "旅行", count: 10 }, { value: "公園", count: 3 }];
context.renderTags(tags);
assert.equal(elements.tagTotalCount.textContent, "タグ数 2");
state.tagQuery = "旅行";
context.renderTags(state.availableTags);
assert.equal(elements.tagList.items.length, 1);
assert.equal(elements.tagTotalCount.textContent, "タグ数 2");
state.tagQuery = "該当なし";
context.renderTags(state.availableTags);
assert.equal(elements.tagTotalCount.textContent, "タグ数 2");
state.tagQuery = "";
context.renderTags([...tags, { value: "新規", count: 1 }]);
assert.equal(elements.tagTotalCount.textContent, "タグ数 3", "new unique tag increases total");
context.renderTags(tags.map((tag) => ({ ...tag, count: tag.count + 1 })));
assert.equal(elements.tagTotalCount.textContent, "タグ数 2", "removed tag decreases total; usage counts do not affect it");
context.renderTags([{ value: "別世帯", count: 20 }]);
assert.equal(elements.tagTotalCount.textContent, "タグ数 1", "new household metadata replaces the total");
context.renderTags([]);
assert.equal(elements.tagTotalCount.textContent, "タグ数 0");
assert.equal(elements.tagList.items[0].text, "#はまだありません。");

process.stdout.write("Diary tag totals, ordering and scrolling contract test passed.\n");
