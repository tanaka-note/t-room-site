import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8797;
const origin = `http://127.0.0.1:${port}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

const migration = spawnSync(process.execPath, [wranglerPath, "d1", "migrations", "apply", "diary-db", "--local"], {
  cwd: projectDirectory,
  encoding: "utf8"
});
assert.equal(migration.status, 0, migration.stderr || migration.stdout);

const server = spawn(process.execPath, [
  wranglerPath,
  "dev",
  "--local",
  "--port",
  String(port),
  "--var",
  "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var",
  "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var",
  `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var",
  `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var",
  "SESSION_SECRET:diary-photo-integration-test-session-secret"
], {
  cwd: projectDirectory,
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/diary/api/session`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local diary server did not start.\n${serverOutput}`);
}

async function jsonRequest(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers["X-Diary-Request"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${origin}/diary/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

async function login(loginId, password) {
  const { response, result } = await jsonRequest("/login", { method: "POST", body: { loginId, password } });
  assert.equal(response.status, 200, JSON.stringify(result));
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function queryLocalDatabase(command) {
  const result = spawnSync(process.execPath, [
    wranglerPath,
    "d1",
    "execute",
    "diary-db",
    "--local",
    "--json",
    "--command",
    command
  ], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout)[0].results;
}

try {
  await waitForServer();
  const wifeCookie = await login("wife@example.test", "wife-test");
  const photoId = randomUUID();
  const created = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-10",
      title: `photo-test-${photoId}`,
      content: `写真の記録\n[[写真:${photoId}]]`,
      tags: ["写真"]
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  const entry = created.result.entry;

  const form = new FormData();
  form.set("id", photoId);
  form.set("width", "1200");
  form.set("height", "800");
  form.set("original", new File([new Uint8Array([1, 2, 3, 4])], "family-photo.png", { type: "image/png" }));
  form.set("display", new File([new Uint8Array([5, 6, 7])], "display.webp", { type: "image/webp" }));
  form.set("thumbnail", new File([new Uint8Array([8, 9])], "thumbnail.webp", { type: "image/webp" }));
  const uploadResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: form
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(upload));
  assert.equal(upload.photo.id, photoId);

  const detailed = await jsonRequest(`/entries/${entry.id}`, { cookie: wifeCookie });
  assert.equal(detailed.response.status, 200);
  assert.equal(detailed.result.entry.photos.length, 1);
  assert.equal(detailed.result.entry.photos[0].fileName, "family-photo.png");

  const roll = await jsonRequest(`/photos?q=${encodeURIComponent(photoId)}`, { cookie: wifeCookie });
  assert.equal(roll.response.status, 200);
  assert.ok(roll.result.photos.some((photo) => photo.id === photoId));
  const imageResponse = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/webp");

  const deletablePhotoId = randomUUID();
  const deletableForm = new FormData();
  deletableForm.set("id", deletablePhotoId);
  deletableForm.set("width", "640");
  deletableForm.set("height", "480");
  deletableForm.set("original", new File([new Uint8Array([10, 11, 12])], "delete-me.png", { type: "image/png" }));
  deletableForm.set("display", new File([new Uint8Array([13, 14])], "delete-me-display.webp", { type: "image/webp" }));
  deletableForm.set("thumbnail", new File([new Uint8Array([15])], "delete-me-thumbnail.webp", { type: "image/webp" }));
  const deletableUploadResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: deletableForm
  });
  const deletableUpload = await deletableUploadResponse.json();
  assert.equal(deletableUploadResponse.status, 200, JSON.stringify(deletableUpload));

  const photoDelete = await jsonRequest(`/photos/${deletablePhotoId}`, {
    method: "DELETE",
    cookie: wifeCookie
  });
  assert.equal(photoDelete.response.status, 200, JSON.stringify(photoDelete.result));
  const deletedPhotoAsset = await fetch(`${origin}${deletableUpload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(deletedPhotoAsset.status, 404);
  const afterPhotoDelete = await jsonRequest(`/entries/${entry.id}`, { cookie: wifeCookie });
  assert.equal(afterPhotoDelete.result.entry.photos.some((photo) => photo.id === deletablePhotoId), false);
  const rollAfterPhotoDelete = await jsonRequest(`/photos?q=${encodeURIComponent(deletablePhotoId)}`, { cookie: wifeCookie });
  assert.equal(rollAfterPhotoDelete.result.photos.some((photo) => photo.id === deletablePhotoId), false);

  const moved = await jsonRequest(`/entries/${entry.id}`, {
    method: "DELETE",
    cookie: wifeCookie,
    body: { revision: detailed.result.entry.revision }
  });
  assert.equal(moved.response.status, 200);
  const visibleInWifeTrash = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(visibleInWifeTrash.status, 200);

  const mainCookie = await login("main@example.test", "main-test");
  const visibleToMain = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: mainCookie } });
  assert.equal(visibleToMain.status, 200);
  const trash = await jsonRequest(`/entries?trash=1&q=${encodeURIComponent(`photo-test-${photoId}`)}`, { cookie: mainCookie });
  const deletedEntry = trash.result.entries.find((candidate) => candidate.id === entry.id);
  const permanent = await jsonRequest(`/entries/${entry.id}/permanent`, {
    method: "DELETE",
    cookie: mainCookie,
    body: { revision: deletedEntry.revision }
  });
  assert.equal(permanent.response.status, 200, JSON.stringify(permanent.result));
  assert.equal(permanent.result.physicallyDeleted, false);
  const hiddenFromMainAfterRetentionDelete = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: mainCookie } });
  assert.equal(hiddenFromMainAfterRetentionDelete.status, 404);
  const retainedForWife = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(retainedForWife.status, 200);

  const wifeTrash = await jsonRequest(`/entries?trash=1&q=${encodeURIComponent(`photo-test-${photoId}`)}`, { cookie: wifeCookie });
  const wifeDeletedEntry = wifeTrash.result.entries.find((candidate) => candidate.id === entry.id);
  assert.ok(wifeDeletedEntry);
  const wifePermanent = await jsonRequest(`/entries/${entry.id}/permanent`, {
    method: "DELETE",
    cookie: wifeCookie,
    body: { revision: wifeDeletedEntry.revision }
  });
  assert.equal(wifePermanent.response.status, 200, JSON.stringify(wifePermanent.result));
  assert.equal(wifePermanent.result.physicallyDeleted, true);
  assert.equal(wifePermanent.result.mediaCleanupPending, false);
  const removedImage = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(removedImage.status, 404);

  const finalDeletionRows = queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_entries WHERE id = ${entry.id}) AS entry_count,
      (SELECT COUNT(*) FROM diary_photos WHERE entry_id = ${entry.id}) AS photo_count,
      (SELECT COUNT(*) FROM diary_trash_scopes WHERE entry_id = ${entry.id}) AS scope_count,
      (SELECT COUNT(*) FROM diary_media_deletion_queue WHERE entry_id = ${entry.id}) AS cleanup_count
  `);
  assert.deepEqual(finalDeletionRows.map((row) => ({
    entryCount: Number(row.entry_count),
    photoCount: Number(row.photo_count),
    scopeCount: Number(row.scope_count),
    cleanupCount: Number(row.cleanup_count)
  })), [{ entryCount: 0, photoCount: 0, scopeCount: 0, cleanupCount: 0 }]);

  const restorePhotoId = randomUUID();
  const restoreCreated = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-11",
      title: `photo-restore-test-${restorePhotoId}`,
      content: `復元する写真\n[[写真:${restorePhotoId}]]`,
      tags: ["写真"]
    }
  });
  assert.equal(restoreCreated.response.status, 200, JSON.stringify(restoreCreated.result));
  const restoreEntry = restoreCreated.result.entry;
  const restoreForm = new FormData();
  restoreForm.set("id", restorePhotoId);
  restoreForm.set("width", "800");
  restoreForm.set("height", "600");
  restoreForm.set("original", new File([new Uint8Array([21, 22, 23])], "restore.png", { type: "image/png" }));
  restoreForm.set("display", new File([new Uint8Array([24, 25])], "restore-display.webp", { type: "image/webp" }));
  restoreForm.set("thumbnail", new File([new Uint8Array([26])], "restore-thumbnail.webp", { type: "image/webp" }));
  const restoreUploadResponse = await fetch(`${origin}/diary/api/entries/${restoreEntry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: restoreForm
  });
  const restoreUpload = await restoreUploadResponse.json();
  assert.equal(restoreUploadResponse.status, 200, JSON.stringify(restoreUpload));

  const restoreMoved = await jsonRequest(`/entries/${restoreEntry.id}`, {
    method: "DELETE",
    cookie: wifeCookie,
    body: { revision: restoreEntry.revision }
  });
  assert.equal(restoreMoved.response.status, 200, JSON.stringify(restoreMoved.result));
  const restored = await jsonRequest(`/entries/${restoreEntry.id}/restore`, {
    method: "POST",
    cookie: mainCookie
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.result));
  assert.equal(restored.result.entry.deletedAt, null);
  const restoredImage = await fetch(`${origin}${restoreUpload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(restoredImage.status, 200);
  const wifeRestoreTrash = await jsonRequest(`/entries?trash=1&q=${encodeURIComponent(`photo-restore-test-${restorePhotoId}`)}`, { cookie: wifeCookie });
  const mainRestoreTrash = await jsonRequest(`/entries?trash=1&q=${encodeURIComponent(`photo-restore-test-${restorePhotoId}`)}`, { cookie: mainCookie });
  assert.equal(wifeRestoreTrash.result.entries.some((candidate) => candidate.id === restoreEntry.id), false);
  assert.equal(mainRestoreTrash.result.entries.some((candidate) => candidate.id === restoreEntry.id), false);
  const restoredScopes = queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_trash_scopes WHERE entry_id = ${restoreEntry.id}`);
  assert.equal(Number(restoredScopes[0].count), 0);

  process.stdout.write("Diary photo integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
