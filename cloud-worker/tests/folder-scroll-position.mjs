import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(client, /const \{ pushHistory = true, load = true, resetScroll = pushHistory \} = options/);
assert.match(client, /if \(resetScroll\) resetFolderScrollPosition\(\);[\s\S]*?if \(load\) await loadItems\(\);[\s\S]*?if \(resetScroll\) requestAnimationFrame\(resetFolderScrollPosition\)/);
assert.match(client, /function resetFolderScrollPosition\(\) \{[\s\S]*?window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\);[\s\S]*?hideFloatingToolbar\(\)/);
assert.match(client, /await navigateToFolder\(target\.folderId, target\.folderName, \{ pushHistory: false \}\)/);
assert.match(client, /restorePreviewOrigin\(previewOriginId\)/);

console.log("new folder opens at top while back and preview restoration remain intact: ok");
