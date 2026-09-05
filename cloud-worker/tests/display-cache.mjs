import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const [client, cache, html, worker] = await Promise.all([
  readFile(new URL("../public/cloud.js", import.meta.url), "utf8"),
  readFile(new URL("../public/display-cache.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/index.js", import.meta.url), "utf8")
]);

assert.match(cache, /LISTING_LIMIT_BYTES = 512 \* 1024 \* 1024/);
assert.match(cache, /THUMBNAIL_LIMIT_BYTES = 1024 \* 1024 \* 1024/);
assert.match(cache, /lastAccessed/);
assert.match(cache, /async function trim\(kind, limitBytes\)/);
assert.match(cache, /removeOldThumbnailVersions/);
assert.match(client, /const cached = await readDisplayListingCache\(cacheKey\)/);
assert.match(client, /const dataPromise = api\(`\/items\?\$\{params\}`/);
assert.match(client, /renderCachedDisplayListing\(cached\)/);
assert.match(client, /scheduleDisplayListingCacheWrite\(cacheKey\)/);
assert.match(client, /TCloudDisplayCache\?\.getThumbnail/);
assert.match(client, /TCloudDisplayCache\?\.putThumbnail/);
assert.match(client, /state\.session\?\.role === "subadmin" && state\.folderId && !state\.crypto\.folderKeys\.has/);
assert.match(client, /renderedCachedItems && \[401, 403, 404, 423\]/);
assert.match(html, /display-cache\.js\?v=cloud-[a-f0-9]{12}/);
assert.match(worker, /\["\/display-cache\.js", "\/display-cache-20260813-1\.js"\]/);
assert.match(worker, /if \(Number\(body\.cryptoVersion\) !== 1\).*暗号化されたファイルだけ保存できます/);
assert.match(worker, /display_media_kind !== "image"/);
assert.match(worker, /file\.display_media_kind === "video"/);
assert.match(worker, /allowedSignatures = \{[\s\S]*?image:[\s\S]*?audio:[\s\S]*?document:/);
assert.match(client, /if \(mediaKind === "video" \|\| !allowed\[mediaKind\]\?\.has\(signature\)\) return null/);
assert.match(client, /fastDisplay\?\.mediaKind === "image"[\s\S]*?\/display-thumbnail/);
assert.doesNotMatch(client, /fastDisplay\?\.mediaKind === "video"[\s\S]*?\/display-thumbnail/);

const cacheContext = { state: { session: null, credentialSalt: "shared-account-salt" }, TCloudDisplayCache: { supported: () => true } };
vm.createContext(cacheContext);
for (const name of ["memberCacheScope", "displayCacheScope", "offlineAccountScope"]) {
  const start = client.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = client.indexOf("\n}", start) + 2;
  vm.runInContext(`${client.slice(start, end)}; globalThis.${name} = ${name};`, cacheContext);
}
assert.equal(cacheContext.displayCacheScope(), "");
const memberSession = { role: "member", serviceAccountId: "folder-member", serviceLinkId: "member-link-a", rootFolderId: 7, sessionCacheId: "session-a" };
cacheContext.state.session = memberSession;
const initialScope = cacheContext.displayCacheScope();
const initialOfflineScope = cacheContext.offlineAccountScope();
assert.ok(initialScope.startsWith("member:"));
assert.ok(initialOfflineScope.startsWith("member:"));
for (const changes of [{ serviceLinkId: "member-link-b" }, { rootFolderId: 8 }, { sessionCacheId: "session-b" }]) {
  cacheContext.state.session = { ...memberSession, ...changes };
  assert.notEqual(cacheContext.displayCacheScope(), initialScope, "member listing/thumbnail caches are link, root and session scoped");
}
cacheContext.state.session = { ...memberSession, serviceLinkId: "member-link-b" };
assert.notEqual(cacheContext.offlineAccountScope(), initialOfflineScope, "member media never reuses another link's offline scope");
for (const changes of [{ serviceAccountId: "admin" }, { serviceLinkId: "" }, { rootFolderId: null }, { sessionCacheId: "" }]) {
  cacheContext.state.session = { ...memberSession, ...changes };
  assert.equal(cacheContext.displayCacheScope(), "", "incomplete member context must not use shared caches");
}
for (const role of ["admin", "subadmin"]) {
  cacheContext.state.session = { role, sessionCacheId: "session-a" };
  assert.equal(cacheContext.displayCacheScope(), `${role}:shared-account-salt`);
  assert.equal(cacheContext.offlineAccountScope(), role);
}
console.log("device listing and thumbnail caches preserve access boundaries: ok");
