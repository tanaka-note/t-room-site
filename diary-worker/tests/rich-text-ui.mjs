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

const linkModelStart = script.indexOf("const ENTRY_TEXT_LINK_PATTERN");
const linkModelEnd = script.indexOf("function normalizeEntryTextRuns", linkModelStart);
assert.ok(linkModelStart >= 0 && linkModelEnd > linkModelStart, "link model source must exist");
const linkModelSource = script.slice(linkModelStart, linkModelEnd);

const modelSource = [
  extractFunction("normalizeEntryTextRuns", "resolveEntryTextMarks"),
  extractFunction("resolveEntryTextMarks", "tokenizeEntryTextWithLinks"),
  extractFunction("tokenizeEntryTextWithLinks", "appendEntryText"),
  extractFunction("hasTextMarks", "sameTextMarks"),
    extractFunction("sameTextMarks", "mergeRichTextRuns"),
    extractFunction("mergeRichTextRuns", "setRichEditorDocument"),
    extractFunction("getSelectionSegments", "getSelectionFormatState"),
    extractFunction("getSelectionFormatState", "applyFormatToSelection"),
    extractFunction("applyFormatToSelection", "updateEditorKeyboardOffset")
  ].join("\n");
const context = { URL };
vm.runInNewContext(`${linkModelSource}\n${modelSource}; globalThis.apply = applyFormatToSelection; globalThis.inspect = getSelectionFormatState; globalThis.tokenize = tokenizeEntryTextWithLinks; globalThis.findLinks = findEntryTextLinks;`, context);
const { apply, inspect, tokenize, findLinks } = context;

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

let links = findLinks("最新情報: https://example.com");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[0].href, "https://example.com");

links = findLinks("参照: www.example.org/記事");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "www.example.org/記事");
  assert.equal(links[0].href, "https://www.example.org/記事");

links = findLinks("見てください: https://example.com。");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[0].start, "見てください: ".length);
  assert.equal(links[0].end, "見てください: https://example.com".length);

links = findLinks("A https://example.com, B https://a.org)");
  assert.equal(links.length, 2);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[1].text, "https://a.org");
  assert.equal(links[1].href, "https://a.org");

assert.equal(links[0].start, 2);
  assert.equal(links[0].end, "A https://example.com".length);

links = findLinks("https://example.com,");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[0].start, 0);
  assert.equal(links[0].end, "https://example.com".length);

links = findLinks("(https://example.com)");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[0].start, 1);
  assert.equal(links[0].end, "(https://example.com".length);

  links = findLinks("前https://example.com。後");
  assert.equal(links.length, 1);
  assert.equal(links[0].start, "前".length);
  assert.equal(links[0].end, "前https://example.com".length);

links = findLinks("https://example.com/path?a=1&b=2#top。");
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com/path?a=1&b=2#top");
  assert.equal(links[0].start, 0);
  assert.equal(links[0].end, "https://example.com/path?a=1&b=2#top".length);

links = findLinks("A https://example.com。 B https://example.org, C");
  assert.equal(links.length, 2);
  assert.equal(links[0].start, 2);
  assert.equal(links[0].end, "A https://example.com".length);
  assert.equal(links[1].start, "A https://example.com。 B ".length);
  assert.equal(links[1].end, "A https://example.com。 B https://example.org".length);

links = findLinks("javascript:alert(1)");
  assert.equal(links.length, 0);

links = findLinks("X https://example.com Y");
  assert.equal(links.length, 1);
  assert.equal(links[0].href, "https://example.com");

const richTextLinks = tokenize("https://example.com。", [{ start: 0, end: "https://".length, bold: true }, { start: "https://".length, end: "https://example.com".length, color: "blue" }]);
  const richTextLinkTokens = richTextLinks.filter((token) => token.kind === "link");
  assert.equal(richTextLinkTokens.length, 2);
  const richTextLinkText = richTextLinkTokens.map((token) => token.text).join("");
  assert.equal(richTextLinkText, "https://example.com");
  assert.equal(richTextLinkTokens.every((token) => token.href === "https://example.com"), true);

  const mixedText = "URL: https://example.com。 [[写真:abc]]";
  links = findLinks(mixedText);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, "https://example.com");
  assert.equal(links[0].start, "URL: ".length);
  assert.equal(links[0].end, "URL: https://example.com".length);
  const mixedTokens = tokenize(mixedText);
  assert.ok(mixedTokens.some((token) => token.kind === "link"), "URL should remain link within mixed content");
  assert.ok(mixedTokens.some((token) => token.text.includes("[[写真:abc]]")), "Photo marker should remain renderable");

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
