import assert from "node:assert/strict";
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
assert.match(html, /data-format-command="bold"/);
assert.match(html, /data-format-command="italic"/);
assert.match(html, /data-format-command="underline"/);
assert.match(html, /data-format-command="clear"/);
for (const color of ["red", "blue", "green", "orange", "purple", "gray", "light-blue", "brown"]) {
  assert.match(html, new RegExp(`data-format-color="${color}"`));
}
assert.match(script, /function serializeRichEditor\(/);
assert.match(script, /contentFormat: editorDocument\.contentFormat/);
assert.match(script, /function renderEntryContent\(/);
assert.match(script, /createFormattedTextSpan/);
assert.match(script, /document\.execCommand\("removeFormat"/);
assert.match(script, /document\.execCommand\("foreColor"/);
assert.match(script, /document\.execCommand\("styleWithCSS", false, true\)/);
assert.match(script, /restoreEditorSelection\(\);[\s\S]*document\.execCommand\("foreColor", false, color\)/);
const beforeInputStart = script.indexOf("function handleRichEditorBeforeInput");
const beforeInputEnd = script.indexOf("function handleRichEditorPaste", beforeInputStart);
assert.ok(beforeInputStart >= 0 && beforeInputEnd > beforeInputStart);
const beforeInputHandler = script.slice(beforeInputStart, beforeInputEnd);
assert.match(beforeInputHandler, /insertParagraph/);
assert.match(beforeInputHandler, /insertLineBreak/);
assert.match(beforeInputHandler, /insertEditorLineBreak\(\)/);
assert.match(beforeInputHandler, /document\.createElement\("br"\)/, "Enter時は改行要素を挿入してください。");
assert.match(beforeInputHandler, /createFormattedTextSpan\("\\u200b"/, "改行後にスマホでも入力できるキャレット位置を作ってください。");
assert.match(beforeInputHandler, /range\.setStart\(anchorText, anchorText\.nodeValue\.length\)/, "カーソルを次行の入力位置へ移してください。");
assert.match(beforeInputHandler, /elements\.entryContent\.contains\(range\.commonAncestorContainer\)/, "現在の有効なカーソル位置を優先してください。");
assert.match(beforeInputHandler, /canInsertEditorText/, "本文の文字数上限は維持してください。");
assert.match(style, /\.entry-format-toggle \{[^}]*position: fixed;[^}]*left:/s);
assert.match(style, /\.diary-text-color-light-blue/);
assert.match(worker, /validateContentFormat/);
assert.match(worker, /content_format/);
assert.match(migration, /ADD COLUMN content_format TEXT/);

process.stdout.write("Diary rich-text UI contract test passed.\n");
