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

let runs = context.apply(20, [], 2, 10, "color", "red");
assert.deepEqual(JSON.parse(JSON.stringify(runs)), [
  { start: 2, end: 10, bold: false, italic: false, underline: false, color: "red" }
]);
runs = context.apply(20, runs, 2, 10, "color", "blue");
assert.equal(runs[0].color, "blue", "a selected color can be replaced without retyping");
runs = context.apply(20, runs, 2, 10, "bold");
assert.equal(runs[0].bold, true);
runs = context.apply(20, runs, 2, 10, "italic");
assert.equal(runs[0].italic, true);
runs = context.apply(20, runs, 2, 10, "underline");
assert.equal(runs[0].underline, true);
runs = context.apply(20, runs, 2, 10, "bold");
assert.equal(runs[0].bold, false, "the same command toggles only the selected text");
runs = context.apply(20, runs, 4, 6, "color", "default");
assert.equal(runs.some((run) => run.start === 4 && run.end === 6 && !run.color), true,
  "default color removes only the selected color while preserving its other styles");
const selectedState = context.inspect(20, runs, 2, 4);
assert.equal(selectedState.color, "blue");
assert.equal(selectedState.italic, true);
assert.equal(selectedState.underline, true);

assert.match(style, /\.entry-format-toggle \{[^}]*position: fixed;[^}]*left:/s);
assert.match(style, /\.entry-format-colors \{[^}]*grid-template-columns: repeat\(9,/s);
assert.match(style, /\.entry-format-commands \{[^}]*grid-template-columns: repeat\(3,/s);
assert.doesNotMatch(style, /\.format-clear/);
assert.match(style, /\.diary-text-color-light-blue/);
assert.match(worker, /validateContentFormat/);
assert.match(worker, /content_format/);
assert.match(migration, /ADD COLUMN content_format TEXT/);

process.stdout.write("Diary selection-only rich-text UI and model tests passed.\n");
