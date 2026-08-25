import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, client, publicClient, cryptoVault, migration] = await Promise.all([
  readFile(new URL("../src/index.js", import.meta.url), "utf8"),
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/share.js", import.meta.url), "utf8"),
  readFile(new URL("../public/crypto-vault.js", import.meta.url), "utf8"),
  readFile(new URL("../migrations/0011_share_folder_sets.sql", import.meta.url), "utf8")
]);

assert.match(migration, /CREATE TABLE IF NOT EXISTS cloud_share_folders/);
assert.match(migration, /share_wrapped_folder_key TEXT/);
assert.match(migration, /share_folder_key_iv TEXT/);
assert.match(migration, /PRIMARY KEY \(share_id, folder_id\)/);

assert.match(cryptoVault, /SHARE_FOLDER_KEY_CONTEXT/);
assert.match(cryptoVault, /async function wrapFolderForShare/);
assert.match(cryptoVault, /async function unlockFolderFromShare/);
assert.notEqual(
  cryptoVault.match(/SHARE_FOLDER_KEY_CONTEXT = "([^"]+)"/)?.[1],
  cryptoVault.match(/SHARE_FILE_KEY_CONTEXT = "([^"]+)"/)?.[1]
);

assert.match(worker, /"folder-selection"/);
assert.match(worker, /body\.selectedFolders\.length < 2 \|\| body\.selectedFolders\.length > 100/);
assert.match(worker, /ids\.has\(id\)/);
assert.match(worker, /requireShareFolderAccess\(env, session, selectedFolders\.map/);
assert.match(worker, /async function sharedFolderRoot/);
assert.match(worker, /cloud_share_folders sf JOIN cloud_folders root/);
assert.match(worker, /folderSetCount[\s\S]*?sharedFolderRoot/);

assert.match(client, /openShareDialog\("folder-selection", folders\)/);
assert.match(client, /TRoomCrypto\.wrapFolderForShare/);
assert.match(client, /selectedFolders/);
assert.match(client, /ファイルとフォルダは同時に共有できません/);

assert.match(publicClient, /共有フォルダ（\$\{folders\.length\}件）/);
assert.match(publicClient, /TRoomCrypto\.unlockFolderFromShare/);
assert.match(publicClient, /loadItems\(null\)/);
assert.match(publicClient, /folderId: \["folder", "folder-selection"\]/);
assert.doesNotMatch(publicClient, /localStorage|sessionStorage/);

console.log("multiple-folder share contracts: ok");
