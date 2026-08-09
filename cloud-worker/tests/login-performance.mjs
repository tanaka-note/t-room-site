import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

const enterApp = client.match(/async function enterApp[\s\S]*?\n}\n\nasync function logout/)?.[0] || "";
assert.match(enterApp, /await prepareCryptoSession\(password, accountKey\);\s*const loaded = await loadItems\(\);[\s\S]*?scheduleLegacyFolderMigration\(\);/);
assert.doesNotMatch(enterApp, /await migrateLegacyFolderNames/);
assert.doesNotMatch(client, /migrateLegacyFolderBranch/);
assert.match(client, /const data = await api\("\/legacy-folders"\)/);
assert.match(client, /requestIdleCallback/);

assert.match(worker, /path === "\/api\/legacy-folders"[\s\S]*?listLegacyFolders/);
assert.match(worker, /async function listLegacyFolders[\s\S]*?requireAdmin\(session\)/);
assert.match(worker, /name IS NULL OR TRIM\(name\) = '' OR name = '\[encrypted\]'/);

console.log("login renders the initial folder before targeted legacy migration: ok");
