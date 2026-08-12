import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [client, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(client, /const INITIAL_ITEM_PAGE_SIZE = 32/);
assert.match(client, /const BACKGROUND_ITEM_PAGE_SIZE = 64/);
assert.match(client, /const ITEM_RENDER_BATCH_SIZE = 192/);
assert.match(client, /params\.set\("pageSize", String\(INITIAL_ITEM_PAGE_SIZE\)\)/);
assert.match(client, /const serverSort = state\.sortUsesTypeDefaults \|\| state\.sort === "name" \? "updated-desc"/);
assert.match(client, /renderItems\(\);\s*syncUnlockedTopFolderNames\(\);\s*renderedInitialItems = true/);
assert.doesNotMatch(client, /while \(nextFolderOffset != null \|\| nextFileOffset != null\)/);
assert.match(client, /async function loadNextItemPage/);
assert.match(client, /if \(state\.itemPageLoading \|\| !state\.progressiveItemsLoading/);
assert.match(client, /function installItemRenderSentinel/);
assert.match(client, /new IntersectionObserver[\s\S]*?rootMargin: "800px 0px"/);
assert.match(client, /pageParams\.set|folderPageParams\.set/);
assert.match(client, /folderPageParams\.set\("foldersOnly", "1"\)/);
assert.match(client, /filePageParams\.set\("filesOnly", "1"\)/);
assert.match(client, /folderPageParams\.set\("continuation", "1"\)/);
assert.match(client, /filePageParams\.set\("continuation", "1"\)/);
assert.match(client, /const loadGeneration = \+\+state\.itemLoadGeneration/);
assert.match(client, /if \(loadGeneration !== state\.itemLoadGeneration\)/);
assert.match(client, /function normalizeNextItemOffset/);
assert.match(client, /function scheduleEncryptedThumbnailLoading/);
assert.match(client, /const ENCRYPTED_THUMBNAIL_CONCURRENCY = 4/);
assert.match(client, /state\.itemLoadController\?\.abort\(\)/);
assert.match(client, /signal: itemLoadSignal/);
assert.match(client, /function resetBackgroundMediaWork/);
assert.match(client, /state\.backgroundMediaTokens/);

assert.match(worker, /const filesOnly = url\.searchParams\.get\("filesOnly"\) === "1"/);
assert.match(worker, /const continuation = url\.searchParams\.get\("continuation"\) === "1"/);
assert.match(worker, /continuation[\s\S]*?SELECT id FROM cloud_folders WHERE id = \?/);
assert.match(worker, /const filePageSize = uploadIndex \? 500/);
assert.match(worker, /LIMIT \? OFFSET \?/);
assert.match(worker, /const nextFolderOffset = !uploadIndex/);
assert.match(worker, /const nextFileOffset = fileResults\.length > filePageSize/);
assert.match(worker, /breadcrumbs: filesOnly \|\| foldersOnly \? \[\]/);

console.log("progressive folder and file loading: ok");
