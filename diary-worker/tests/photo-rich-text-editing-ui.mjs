import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(`${root}/public/diary.js`, "utf8");

function extractFunction(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must exist before ${nextName}`);
  return script.slice(start, end);
}

const modelSource = [
  extractFunction("hasTextMarks", "sameTextMarks"),
  extractFunction("sameTextMarks", "mergeRichTextRuns"),
  extractFunction("mergeRichTextRuns", "shiftRichTextRunsForInsertion"),
  extractFunction("shiftRichTextRunsForInsertion", "insertTextIntoRichDocument"),
  extractFunction("insertTextIntoRichDocument", "setRichEditorDocument")
].join("\n");
const context = {};
vm.runInNewContext(`${modelSource}; globalThis.insertText = insertTextIntoRichDocument;`, context);

const marker = "[[写真:11111111-2222-3333-4444-555555555555]]";
let documentValue = { content: "ABC", contentFormat: null };
documentValue = context.insertText(documentValue, 3, `\n${marker}`);
documentValue = context.insertText(documentValue, documentValue.content.length, "DEF");
assert.equal(documentValue.content, `ABC\n${marker}DEF`, "文字→写真→文字で既存文字と新規文字を維持する");

const firstMarker = "[[写真:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]]";
const secondMarker = "[[写真:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb]]";
const multiple = context.insertText(
  { content: "前後", contentFormat: null },
  1,
  `${firstMarker}${secondMarker}`
);
assert.equal(multiple.content, `前${firstMarker}${secondMarker}後`);
assert.ok(multiple.content.indexOf(firstMarker) < multiple.content.indexOf(secondMarker), "複数写真の順番を維持する");

const formatted = context.insertText({
  content: "ABCD",
  contentFormat: {
    version: 1,
    runs: [{ start: 0, end: 4, bold: true, italic: false, underline: false, color: "red" }]
  }
}, 2, marker);
assert.equal(formatted.content, `AB${marker}CD`);
assert.deepEqual(JSON.parse(JSON.stringify(formatted.contentFormat.runs)), [
  { start: 0, end: 2, bold: true, italic: false, underline: false, color: "red" },
  { start: 2 + marker.length, end: 4 + marker.length, bold: true, italic: false, underline: false, color: "red" }
], "写真マーカーを挟んでも前後の書式runを維持し、マーカー自体へ書式を広げない");

const photoInsertion = extractFunction("insertPhotoMarkersAtOffset", "handleRichEditorInput");
assert.doesNotMatch(photoInsertion, /deleteContents\(|restoreEditorSelection\(/,
  "写真挿入では保存済みDOM Rangeの復元・選択内容削除を行わない");
assert.match(photoInsertion, /restoreEditorSelectionFromOffsets\(\{ start: caret, end: caret \}\)/,
  "写真挿入後はcollapsed caretへ復元する");
assert.match(photoInsertion, /ids\.map\(photoMarker\)\.join\(""\)/,
  "連続写真は内部マーカーを連結して改行なしで追加する");
assert.match(script, /openPhotoPicker\(\) \{\s*state\.photoInsertionOffset = getEditorSelectionOffset\("end"\)/s,
  "ファイル選択前に選択末尾の論理オフセットを保存する");
const selectionOffset = extractFunction("getEditorSelectionOffset", "captureEditorSelectionOffsets");
assert.match(selectionOffset, /getSerializedEditorRangeOffsets\(range\)/,
  "caret位置はserializerと同じ論理座標へ変換する");
assert.doesNotMatch(selectionOffset, /\.toString\(\)/,
  "DOM Range文字数をserialized offsetとして使用しない");
assert.match(script, /function getSerializedEditorRangeOffsets\(range\)[\s\S]*?cloneNode\(true\)[\s\S]*?serializeRichEditorRoot\(editorClone, false\)/,
  "live DOMを壊さずcloneへboundary markerを置いてserialized offsetを求める");
assert.match(script, /await waitForEditorCompositionEnd\(\);\s*if \(preparedPhotos\.length\)/s,
  "IME composition終了前に写真マーカーを挿入しない");
assert.match(script, /addEventListener\("compositionstart", handleRichEditorCompositionStart\)/);
assert.match(script, /addEventListener\("compositionend", handleRichEditorCompositionEnd\)/);

process.stdout.write("Diary photo rich-text editing regression tests passed.\n");
