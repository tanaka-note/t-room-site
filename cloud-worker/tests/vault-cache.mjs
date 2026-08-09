import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const client = await readFile(new URL("../public/cloud.js", import.meta.url), "utf8");

assert.match(client, /const VAULT_CACHE_DB = "tcloud-device-vault"/);
assert.match(client, /async function loadCachedAdminKey/);
assert.match(client, /key instanceof CryptoKey && key\.type === "private" && key\.extractable === false/);
assert.match(client, /await saveCachedAdminKey\(config, privateKey\)/);
assert.match(client, /await saveCachedAdminKey\(state\.crypto\.config, privateKey\)/);
assert.match(client, /async function clearCachedAdminKeys/);
assert.match(client, /async function logout\(\)[\s\S]*?await clearCachedAdminKeys\(\)/);
assert.match(client, /session\.authenticated[\s\S]*?rememberedPassword[\s\S]*?enterApp\(session, rememberedPassword, accountKey\)/);

console.log("admin device vault reuse and logout cleanup: ok");
