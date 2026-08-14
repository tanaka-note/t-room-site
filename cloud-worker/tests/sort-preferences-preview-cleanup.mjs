import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, shareHtml, main, share] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/share.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

assert.match(main, /const SORT_PREFERENCES_KEY = "tcloud-folder-sort-preferences-v1"/);
assert.match(main, /function restoreFolderSortPreference\(folderId = state\.folderId\)/);
assert.match(main, /function rememberCurrentSort\(folderId = state\.folderId\)/);
assert.match(main, /const role = state\.session\?\.role === "admin" \? "admin" : "subadmin"/);
assert.match(main, /const location = folderId \? `folder:\$\{Number\(folderId\)\}` : "root"/);
assert.match(main, /rememberCurrentSort\(\);[\s\S]*?syncSortControls\(\)/);
assert.equal((main.match(/restoreFolderSortPreference\(/g) || []).length >= 4, true);

for (const client of [main, share]) {
  assert.match(client, /querySelectorAll\("video, audio"\)/);
  assert.match(client, /media\.pause\(\)/);
  assert.match(client, /media\.removeAttribute\("src"\)/);
  assert.match(client, /media\.load\(\)/);
  assert.match(client, /previewGeneration \+= 1/);
  assert.match(client, /\.unload\(\)/);
  assert.match(client, /\.detachMediaElement\(\)/);
  assert.match(client, /\.destroy\(\)/);
  assert.match(client, /stage\?\.replaceChildren\(\)/);
}

assert.match(main, /TCloudMedia\.releaseMedia\(media\.token\)/);
assert.match(share, /TCloudMedia\.releaseMedia\(media\.token\)/);
assert.match(mainHtml, /cloud\.js\?v=20260814-3/);
assert.match(shareHtml, /share\.js\?v=20260814-1/);

console.log("per-folder sort memory and complete preview cleanup: ok");
