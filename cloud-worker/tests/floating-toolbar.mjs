import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, client, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.css", import.meta.url), "utf8")
]);

assert.match(html, /id="floating-toolbar"[^>]*aria-hidden="true"/);
assert.match(html, /id="floating-folder-name">すべてのファイル/);
assert.match(html, /id="floating-search-input"/);
assert.match(html, /id="floating-sort-controls"[\s\S]*?更新[\s\S]*?名前[\s\S]*?容量/);
assert.match(client, /window\.addEventListener\("scroll", queueFloatingToolbarUpdate, \{ passive: true \}\)/);
assert.match(client, /const FLOATING_TOOLBAR_SCROLL_THRESHOLD = 30/);
assert.match(client, /programmaticUntil = Date\.now\(\) \+ 900/);
assert.match(client, /if \(direction > 0\) showFloatingToolbar\(\);[\s\S]*?else hideFloatingToolbar\(\);/);
assert.match(client, /if \(!\$\("#selection-bar"\)\.hidden \|\| state\.uploading \|\| state\.downloadActive\) return false/);
assert.match(client, /function renderFloatingLocation\(items\)/);
assert.match(client, /pathNames\.join\(" \/ "\)/);
assert.match(client, /\.sort-controls \[data-sort-key\]/);
assert.match(styles, /\.floating-toolbar \{ position: fixed/);
assert.match(styles, /\.floating-toolbar\.is-visible/);
assert.match(styles, /#floating-folder-name \{[^}]*text-overflow: ellipsis/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.floating-toolbar-location \{ grid-column: 1 \/ -1/);

console.log("direction-aware compact folder toolbar: ok");
