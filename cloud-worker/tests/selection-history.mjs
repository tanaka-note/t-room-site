import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, shareHtml, main, share, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8")
]);

for (const client of [main, share]) {
  assert.match(client, /selectionHistoryActive/);
  assert.match(client, /beginSelectionHistory\(\)/);
  assert.match(client, /clearFileSelection\(true, false\)/);
  assert.match(client, /history\.back\(\)/);
  assert.match(client, /sameFolder/);
}

assert.match(mainHtml, /id="selection-all"/);
assert.match(shareHtml, /id="share-selection-all"/);
assert.match(main, /function selectAllVisibleItems\(\)/);
assert.match(share, /function selectAllSharedFiles\(\)/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.selection-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[^}]*max-width: none/);

console.log("selection back navigation and select all: ok");
