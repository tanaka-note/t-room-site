import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
  assert.match(client, /function clearSelectionWithoutRefresh\(\)/);
  assert.match(client, /selectionClearBackPending = true/);
  assert.match(client, /if \(state\.selectionClearBackPending\)/);
}

assert.match(mainHtml, /id="selection-all"/);
assert.match(shareHtml, /id="share-selection-all"/);
assert.match(main, /function selectAllVisibleItems\(\)/);
assert.match(share, /function selectAllSharedFiles\(\)/);
assert.match(main, /#selection-clear"\)\.addEventListener\("click", clearSelectionWithoutRefresh\)/);
assert.match(share, /#share-selection-clear"\)\.addEventListener\("click", clearSelectionWithoutRefresh\)/);
assert.match(styles, /@media \(max-width: 520px\)[\s\S]*?\.selection-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[^}]*max-width: none/);
assert.match(main, /const canDownloadSelection = fileCount > 0 && folderCount === 0;/);
assert.match(main, /\$\("#selection-download"\)\.hidden = !canDownloadSelection;/);
assert.match(main, /\$\("#selection-download"\)\.disabled = !canDownloadSelection;/);

// A queued restoration must not move a new folder, refreshed listing, preview or selection.
const restoreSource = main.slice(main.indexOf("function selectionScrollPosition"), main.indexOf("async function handleHistoryNavigation"));
for (const [name, navigate] of [
  ["folder", context => { context.state.folderId = 9; }],
  ["listing refresh", context => { context.state.itemLoadGeneration++; }],
  ["preview", context => { context.history.state.previewId = 2; }],
  ["new selection", context => { context.history.state.selection = true; }]
]) {
  const frames = [], scrolls = [];
  const context = vm.createContext({
    state: { folderId: 8, itemLoadGeneration: 4 }, history: { state: { tcloud: true } },
    appScrollPosition: () => ({ x: 12, y: 600 }), scrollAppTo: value => scrolls.push(value),
    requestAnimationFrame: callback => frames.push(callback)
  });
  vm.runInContext(restoreSource + "; restoreSelectionScrollPosition(selectionScrollPosition());", context);
  navigate(context);
  while (frames.length) frames.shift()();
  assert.deepEqual(scrolls, [], name + " cancels stale position restoration");
}

console.log("selection back navigation, select all and stale scroll restoration guards: ok");
