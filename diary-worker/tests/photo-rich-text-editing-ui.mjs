import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  findPhotoMarkers,
  insertTextIntoRichDocument as insertText,
  replaceTextInRichDocument,
  tokenizeEditorDocument
} from "../public/diary-rich-text.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(`${root}/public/diary.js`, "utf8");

function extractFunction(name, nextName) {
  const start = script.indexOf(`function ${name}`);
  const end = script.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} must exist before ${nextName}`);
  return script.slice(start, end);
}

const marker = "[[写真:11111111-2222-3333-4444-555555555555]]";
let documentValue = { content: "ABC", contentFormat: null };
documentValue = insertText(documentValue, 3, `\n${marker}`);
documentValue = insertText(documentValue, documentValue.content.length, "DEF");
assert.equal(documentValue.content, `ABC\n${marker}DEF`, "文字→写真→文字で既存文字と新規文字を維持する");

const firstMarker = "[[写真:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa]]";
const secondMarker = "[[写真:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb]]";
const multiple = insertText(
  { content: "前後", contentFormat: null },
  1,
  `${firstMarker}${secondMarker}`
);
assert.equal(multiple.content, `前${firstMarker}${secondMarker}後`);
assert.ok(multiple.content.indexOf(firstMarker) < multiple.content.indexOf(secondMarker), "複数写真の順番を維持する");

const formatted = insertText({
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

const markerTokens = tokenizeEditorDocument(`前${marker}後`, [
  { start: 0, end: marker.length + 2, bold: true }
]);
assert.deepEqual(markerTokens.map((token) => token.kind), ["text", "photo-marker", "text"],
  "保存文字列内の写真マーカーを単一のatomic tokenへ分離する");
assert.equal(markerTokens[1].marker, marker);
assert.equal(markerTokens[1].marks, null, "写真tokenへ本文書式を適用しない");
assert.deepEqual(findPhotoMarkers(`${firstMarker}${secondMarker}`).map((item) => item.marker), [firstMarker, secondMarker],
  "連続写真マーカーの完全な値と順序を抽出する");

const replaced = replaceTextInRichDocument({
  content: "ABCD",
  contentFormat: { version: 1, runs: [{ start: 0, end: 4, bold: true }] }
}, 1, 3, "X");
assert.equal(replaced.content, "AXD");
assert.deepEqual(replaced.contentFormat.runs, [
  { start: 0, end: 1, bold: true, italic: false, underline: false, color: null },
  { start: 2, end: 3, bold: true, italic: false, underline: false, color: null }
], "paste置換では挿入文字へ既存runを広げず、前後runを維持する");

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
assert.match(script, /marker\.contentEditable = "false"/,
  "editor DOMでは写真マーカーを編集不可能なtokenとして描画する");
assert.match(script, /node\.matches\("\[data-photo-marker\]"\)[\s\S]*?node\.dataset\.photoMarker/,
  "単一serializerがatomic tokenを従来marker文字列へ戻す");
assert.match(script, /inputWouldModifyPhotoMarker\(event\.inputType\)/,
  "通常入力のbeforeinput経路でmarkerを含む置換と削除を拒否する");
const restoreFromOffsets = extractFunction("restoreEditorSelectionFromOffsets", "insertPlainTextAtEditorSelection");
assert.match(restoreFromOffsets, /kind: "photo-marker"/,
  "selection復元はmarkerを文字nodeではなくatomic unitとして数える");
assert.doesNotMatch(restoreFromOffsets, /remaining <= node\.nodeValue\.length/,
  "marker末尾をmarker内部text nodeへ復元する旧境界判定を残さない");

process.stdout.write("Diary photo rich-text editing regression tests passed.\n");
