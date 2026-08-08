import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const client = await readFile(new URL("../public/share.js", import.meta.url), "utf8");

assert.match(client, /window\.addEventListener\("popstate", handleShareHistoryNavigation\)/);
assert.match(client, /loadItems\(null, null, \{ historyMode: "replace" \}\)/);
assert.match(client, /history\.replaceState\(entry/);
assert.match(client, /history\.pushState\(entry/);
assert.match(client, /history\.back\(\)/);
assert.match(client, /previewHistoryActive/);
assert.match(client, /await loadItems\(entry\.folderId, null, \{ historyMode: "none", historyPath: entry\.path \|\| \[\] \}\)/);
assert.match(client, /await openPreview\(file, \{ pushHistory: false \}\)/);

console.log("shared folder and preview browser history: ok");
