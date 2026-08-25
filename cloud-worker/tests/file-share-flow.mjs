import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [mainHtml, mainClient, shareClient] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8")
]);

assert.match(mainHtml, /id="selection-share"[^>]*>共有</);
assert.match(mainClient, /openShareDialog\("file", files\[0\]\)/);
assert.match(mainClient, /openShareDialog\("selection", files\)/);
assert.match(mainClient, /openShareDialog\("folder", folders\[0\]\)/);
assert.match(mainClient, /openShareDialog\("folder-selection", folders\)/);
assert.match(mainClient, /ファイルとフォルダは同時に共有できません/);
assert.match(mainClient, /files\.every\(canShareFile\)/);
assert.match(mainClient, /folders\.every\(canShareFolder\)/);
assert.match(mainClient, /function canShareFile\(file\)/);
assert.match(mainClient, /state\.canTrashCurrentFolderContents/);
assert.match(mainClient, /function canShareFolder\(folder\)/);
assert.match(mainClient, /folder\.isUnlocked/);
assert.match(mainClient, /PWで解除したフォルダ内のデータだけ共有できます/);
assert.match(mainClient, /TRoomCrypto\.wrapFileForShare/);
assert.match(shareClient, /directFile = file/);
assert.match(shareClient, /if \(directFile\) await openPreview\(directFile, \{ pushHistory: false \}\)/);
assert.match(shareClient, /data\.targetType === "selection"/);
assert.match(shareClient, /TRoomCrypto\.unlockFileFromShare/);
assert.match(shareClient, /data\.targetType === "folder-selection"/);
assert.match(shareClient, /TRoomCrypto\.unlockFolderFromShare/);

console.log("single and selected multi-file share flows: ok");
