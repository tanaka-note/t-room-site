import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [html, script, style, worker, migration] = await Promise.all([
  readFile(`${root}/public/index.html`, "utf8"),
  readFile(`${root}/public/diary.js`, "utf8"),
  readFile(`${root}/public/diary.css`, "utf8"),
  readFile(`${root}/src/index.js`, "utf8"),
  readFile(`${root}/migrations/0010_entry_rich_text.sql`, "utf8")
]);

assert.match(html, /id="entry-content"[^>]*contenteditable="true"/);
assert.match(html, /id="entry-format-toggle"/);
assert.match(html, /class="entry-format-colors"/);
assert.match(html, /class="entry-format-commands"/);
for (const command of ["bold", "italic", "underline"]) {
  assert.match(html, new RegExp(`data-format-command="${command}"`));
}
assert.doesNotMatch(html, /data-format-command="clear"/);
for (const color of ["default", "red", "blue", "green", "orange", "purple", "gray", "light-blue", "brown"]) {
  assert.match(html, new RegExp(`data-format-color="${color}"`));
}

assert.match(script, /function serializeRichEditor\(/);
assert.match(script, /contentFormat: editorDocument\.contentFormat/);
assert.match(script, /function renderEntryContent\(/);
assert.match(script, /createFormattedTextSpan/);
assert.doesNotMatch(script, /document\.execCommand/);
assert.doesNotMatch(script, /typingMarker|editorTyping|installTypingFormat/);
assert.match(script, /function captureEditorSelectionOffsets\(\)/);
assert.match(script, /function findEntryTextLinks\(/);
assert.match(script, /function tokenizeEntryTextWithLinks\(/);
assert.match(script, /function createEntryTextLink\(/);
assert.match(script, /function applyFormatToSelection\(/);
assert.match(script, /function restoreEditorSelectionFromOffsets\(/);
assert.match(script, /function preserveEditorSelectionFromToolbar\(\) \{\s*rememberEditorSelection\(\);\s*captureEditorSelectionOffsets\(\);\s*\}/,
  "touching the pencil must preserve the selection without cancelling the synthesized mobile click");
assert.match(script, /書式を変更する文字を選択してください。/);
assert.match(script, /function handleRichEditorInput\(\) \{\s*state\.editorDirty = true;\s*if \(state\.editorToolbarOpen\) closeEntryFormatToolbar\(\);\s*\}/);

const beforeInputStart = script.indexOf("function handleRichEditorBeforeInput");
const beforeInputEnd = script.indexOf("function handleRichEditorPaste", beforeInputStart);
assert.ok(beforeInputStart >= 0 && beforeInputEnd > beforeInputStart);
const beforeInputHandler = script.slice(beforeInputStart, beforeInputEnd);
assert.match(beforeInputHandler, /insertParagraph/);
assert.match(beforeInputHandler, /insertLineBreak/);
assert.match(beforeInputHandler, /canInsertEditorText/);
assert.doesNotMatch(beforeInputHandler, /insertEditorLineBreak/);

function extractFunction(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must exist before ${nextName}`);
  return script.slice(start, end);
}

const modelSource = [
  extractFunction("hasTextMarks", "sameTextMarks"),
  extractFunction("sameTextMarks", "mergeRichTextRuns"),
  extractFunction("mergeRichTextRuns", "setRichEditorDocument"),
  extractFunction("getSelectionSegments", "getSelectionFormatState"),
  extractFunction("getSelectionFormatState", "applyFormatToSelection"),
  extractFunction("applyFormatToSelection", "updateEditorKeyboardOffset")
].join("\n");
const context = {};
vm.runInNewContext(`${modelSource}; globalThis.apply = applyFormatToSelection; globalThis.inspect = getSelectionFormatState;`, context);
const { apply, inspect } = context;

function findEntryTextLinksForTest(text) {
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`[\]{}()<>]+/g;
  const trimTrailing = /[.,。、!?！？)\]\}"'”』】〉》）]+$/u;
  const source = String(text || "");
  const links = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const matched = match[0];
    let end = matched.length;
    while (end > 0 && trimTrailing.test(matched[end - 1])) end -= 1;
    if (end === 0) continue;
    const textValue = matched.slice(0, end);
    const href = textValue.startsWith("www.") ? `https://${textValue}` : textValue;
    if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
    try {
      const parsed = new URL(href);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
    } catch (error) {
      continue;
    }
    links.push({ text: textValue, href });
  }
  return links;
}

let runs = apply(20, [], 2, 10, "color", "red");
assert.deepEqual(JSON.parse(JSON.stringify(runs)), [
  { start: 2, end: 10, bold: false, italic: false, underline: false, color: "red" }
]);
runs = apply(20, runs, 2, 10, "color", "blue");
assert.equal(runs[0].color, "blue", "a selected color can be replaced without retyping");
runs = apply(20, runs, 2, 10, "bold");
assert.equal(runs[0].bold, true);
runs = apply(20, runs, 2, 10, "italic");
assert.equal(runs[0].italic, true);
runs = apply(20, runs, 2, 10, "underline");
assert.equal(runs[0].underline, true);
runs = apply(20, runs, 2, 10, "bold");
assert.equal(runs[0].bold, false, "the same command toggles only the selected text");
runs = apply(20, runs, 4, 6, "color", "default");
assert.equal(runs.some((run) => run.start === 4 && run.end === 6 && !run.color), true,
  "default color removes only the selected color while preserving its other styles");
const selectedState = inspect(20, runs, 2, 4);
assert.equal(selectedState.color, "blue");
assert.equal(selectedState.italic, true);
assert.equal(selectedState.underline, true);

let links = findEntryTextLinksForTest("最新情報: https://example.com");
assert.equal(links.length, 1);
assert.equal(links[0].text, "https://example.com");
assert.equal(links[0].href, "https://example.com");

links = findEntryTextLinksForTest("参照: www.example.org/記事");
assert.equal(links.length, 1);
assert.equal(links[0].text, "www.example.org/記事");
assert.equal(links[0].href, "https://www.example.org/記事");

links = findEntryTextLinksForTest("見てください: https://example.com。");
assert.equal(links.length, 1);
assert.equal(links[0].text, "https://example.com");

links = findEntryTextLinksForTest("A https://example.com, B https://a.org)");
assert.equal(links.length, 2);
assert.equal(links[0].text, "https://example.com");
assert.equal(links[1].text, "https://a.org");
assert.equal(links[1].href, "https://a.org");

links = findEntryTextLinksForTest("javascript:alert(1)");
assert.equal(links.length, 0);

links = findEntryTextLinksForTest("X https://example.com Y");
assert.equal(links.length, 1);
assert.equal(links[0].href, "https://example.com");

assert.match(style, /\.entry-format-toggle \{[^}]*position: fixed;[^}]*left:/s);
assert.match(style, /\.entry-format-colors \{[^}]*grid-template-columns: repeat\(9,/s);
assert.match(style, /\.entry-format-commands \{[^}]*grid-template-columns: repeat\(3,/s);
assert.match(style, /\.entry-content a\.entry-content-link/);
assert.doesNotMatch(style, /\.format-clear/);
assert.match(style, /\.diary-text-color-light-blue/);
assert.match(worker, /validateContentFormat/);
assert.match(worker, /content_format/);
assert.match(migration, /ADD COLUMN content_format TEXT/);

process.stdout.write("Diary selection-only rich-text UI and model tests passed.\n");
