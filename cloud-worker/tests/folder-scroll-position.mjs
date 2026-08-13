import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(client, /const \{ pushHistory = true, load = true, resetScroll = pushHistory, originType = "", originId = null, restoreEntry = null \} = options/);
assert.match(client, /if \(resetScroll\) resetFolderScrollPosition\(\);[\s\S]*?if \(load\) await loadItems\(\);[\s\S]*?if \(resetScroll\) requestAnimationFrame\(resetFolderScrollPosition\)/);
assert.match(client, /function resetFolderScrollPosition\(\) \{[\s\S]*?window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\);[\s\S]*?hideFloatingToolbar\(\)/);
assert.match(client, /await navigateToFolder\(target\.folderId, target\.folderName, \{ pushHistory: false, restoreEntry: target \}\)/);
assert.match(client, /restorePreviewOrigin\(previewOriginId\)/);
assert.match(client, /function rememberCurrentNavigationPosition\(originType = "", originId = null\)/);
assert.match(client, /scrollX: Math\.max\(0, window\.scrollX \|\| 0\)/);
assert.match(client, /scrollY: Math\.max\(0, window\.scrollY \|\| 0\)/);
assert.match(client, /navigateToFolder\(folder\.id, folder\.name, \{ originType: "folder", originId: folder\.id \}\)/);
assert.match(client, /rememberCurrentNavigationPosition\("file", file\.id\)/);
assert.match(client, /await navigateToFolder\(target\.folderId, target\.folderName, \{ pushHistory: false, restoreEntry: target \}\);[\s\S]*?await restoreNavigationPosition\(target\)/);
assert.match(client, /query: state\.query,[\s\S]*?listMode: state\.listMode/);
assert.match(client, /state\.query = restoreEntry \? String\(restoreEntry\.query \|\| ""\) : ""/);
assert.match(client, /async function ensureNavigationOriginRendered\(entry\)/);
assert.match(client, /await loadNextItemPage\(\)/);
assert.match(client, /async function restoreNavigationPosition\(entry\)/);
assert.match(client, /previewOriginScrollX: 0,[\s\S]*?previewOriginScrollY: 0/);
assert.match(client, /state\.previewOriginScrollX = Math\.max\(0, window\.scrollX \|\| 0\)/);
assert.match(client, /state\.previewOriginScrollY = Math\.max\(0, window\.scrollY \|\| 0\)/);
assert.match(client, /function restorePreviewOrigin\(fileId, scrollX = state\.previewOriginScrollX, scrollY = state\.previewOriginScrollY\)/);
assert.match(client, /window\.scrollTo\(\{ top, left, behavior: "auto" \}\)/);
assert.match(client, /requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(restore\)[\s\S]*?setTimeout\(restore, 80\)/);

const rememberStart = client.indexOf("function rememberCurrentNavigationPosition");
const rememberEnd = client.indexOf("async function navigateToFolder", rememberStart);
assert.ok(rememberStart >= 0 && rememberEnd > rememberStart);
let replacedState = null;
const rememberContext = {
  state: { historyReady: true, folderId: 30, kind: "video", view: "all", query: "sample", listMode: true },
  history: {
    state: { tcloud: true, folderId: 30, previewId: null },
    replaceState: (value) => { replacedState = value; }
  },
  location: { href: "https://example.test/cloud/" },
  window: { scrollX: 12, scrollY: 845 },
  $: () => ({ textContent: "C" }),
  Number
};
vm.runInNewContext(`${client.slice(rememberStart, rememberEnd)}; rememberCurrentNavigationPosition("folder", 11);`, rememberContext);
assert.equal(replacedState.scrollY, 845);
assert.equal(replacedState.originType, "folder");
assert.equal(replacedState.originId, 11);
assert.equal(replacedState.query, "sample");
assert.equal(replacedState.listMode, true);

console.log("folder and file back navigation restores the exact previous list position: ok");
