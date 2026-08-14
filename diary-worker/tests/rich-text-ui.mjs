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
assert.match(style, /\.entry-format-toggle \{[^}]*position: fixed;[^}]*left:/s);
assert.match(style, /\.diary-text-color-light-blue/);
assert.match(worker, /validateContentFormat/);
assert.match(worker, /content_format/);
assert.match(migration, /ADD COLUMN content_format TEXT/);

process.stdout.write("Diary rich-text UI contract test passed.\n");
