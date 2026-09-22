import { randomBytes } from 'node:crypto';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8808;
const origin = `http://127.0.0.1:${port}`;
const marker = `draft-test-${randomUUID()}`;
const hiddenTag = `draft-${randomUUID().slice(0, 8)}`;
const editTag = `edit-${randomUUID().slice(0, 8)}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", `UPDATE diary_accounts SET password_hash = '${testHash("chiharu-test")}', must_change_password = 0 WHERE id = 'chiharu-admin'; INSERT INTO diary_accounts (id, household_id, display_name, login_id, password_hash, role, must_change_password, can_view_trash, can_permanently_delete, can_view_investment, can_manage_entries, session_version, active) VALUES ('draft-readonly', 'tanaka-household', '閲覧者', 'draft-readonly@example.test', '${testHash("readonly-test")}', 'user', 0, 0, 0, 0, 0, 1, 1) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, must_change_password = 0, can_manage_entries = 0, active = 1; DELETE FROM diary_entries WHERE title LIKE 'draft-test-%';`]
]) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", `SESSION_SECRET:${randomBytes(32).toString("hex")}`,
  "--var", "STAGED_PHOTO_UPLOAD_TEST_PAUSE_MS:1"
], { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`${origin}/diary/api/session`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start.\n${output}`);
}

async function request(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers["X-Diary-Request"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${origin}/diary/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { response, result, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

async function login(loginId, password) {
  const result = await request("/login", { method: "POST", body: { loginId, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  return result.cookie;
}

try {
  await waitForServer();
  const mainCookie = await login("main@example.test", "main-test");
  const wifeCookie = await login("wife@example.test", "wife-test");
  const chiharuCookie = await login("giantz3031@gmail.com", "chiharu-test");
  const readonlyCookie = await login("draft-readonly@example.test", "readonly-test");

  const published = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: { entryDate: "2026-08-15", title: `${marker}-published`, content: "公開中の本文", tags: [editTag] }
  });
  assert.equal(published.response.status, 200, JSON.stringify(published.result));
  assert.equal(published.result.entry.status, "published");

  const draft = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: { entryDate: "2026-08-15", title: "", content: "", tags: [hiddenTag], status: "draft" }
  });
  assert.equal(draft.response.status, 200, JSON.stringify(draft.result));
  assert.equal(draft.result.entry.status, "draft");
  const draftId = draft.result.entry.id;

  const normalBeforePost = await request(`/entries?q=${encodeURIComponent(marker)}`, { cookie: mainCookie });
  assert.equal(normalBeforePost.result.entries.some((entry) => entry.id === draftId), false);
  const draftList = await request("/entries?draft=1", { cookie: mainCookie });
  assert.equal(draftList.result.entries.some((entry) => entry.id === draftId), true);
  assert.equal((await request("/entries?draft=1", { cookie: wifeCookie })).result.entries.some((entry) => entry.id === draftId), true);
  assert.equal((await request(`/entries/${draftId}`, { cookie: chiharuCookie })).response.status, 404);

  const metaBeforePost = await request("/meta", { cookie: mainCookie });
  assert.equal(metaBeforePost.result.tags.some((tag) => tag.value === hiddenTag), false);
  assert.ok(metaBeforePost.result.draftCount >= 1);

  const deletableDraft = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: { entryDate: "2026-08-16", title: `${marker}-delete`, content: "削除する下書き", tags: [hiddenTag], status: "draft" }
  });
  assert.equal(deletableDraft.response.status, 200, JSON.stringify(deletableDraft.result));
  const countWithDeletableDraft = (await request("/meta", { cookie: mainCookie })).result.draftCount;
  assert.equal(countWithDeletableDraft, metaBeforePost.result.draftCount + 1);
  assert.equal((await request("/entries?draft=1", { cookie: mainCookie })).result.entries.some(
    (entry) => entry.id === deletableDraft.result.entry.id
  ), true);
  const unauthorizedDelete = await request(`/drafts/${deletableDraft.result.entry.id}`, {
    method: "DELETE", cookie: readonlyCookie, body: { revision: deletableDraft.result.entry.revision }
  });
  assert.equal(unauthorizedDelete.response.status, 403);
  const otherHouseholdDelete = await request(`/drafts/${deletableDraft.result.entry.id}`, {
    method: "DELETE", cookie: chiharuCookie, body: { revision: deletableDraft.result.entry.revision }
  });
  assert.equal(otherHouseholdDelete.response.status, 409);
  const stagedSession = await request("/photo-upload-sessions", {
    method: "POST", cookie: mainCookie, body: { targetEntryId: deletableDraft.result.entry.id }
  });
  assert.equal(stagedSession.response.status, 200, JSON.stringify(stagedSession.result));
  const stagedPhotoId = randomUUID();
  const stagedPhotoForm = new FormData();
  stagedPhotoForm.set("id", stagedPhotoId);
  stagedPhotoForm.set("width", "6");
  stagedPhotoForm.set("height", "7");
  stagedPhotoForm.set("original", new File([new Uint8Array([31, 32, 33])], "staged.png", { type: "image/png" }));
  stagedPhotoForm.set("display", new File([new Uint8Array([34, 35])], "display.webp", { type: "image/webp" }));
  stagedPhotoForm.set("thumbnail", new File([new Uint8Array([36])], "thumbnail.webp", { type: "image/webp" }));
  const stagedPhotoUpload = await fetch(
    `${origin}/diary/api/photo-upload-sessions/${stagedSession.result.uploadSession.id}/photos`,
    { method: "POST", headers: { Cookie: mainCookie, "X-Diary-Request": "1" }, body: stagedPhotoForm }
  );
  assert.equal(stagedPhotoUpload.status, 200, await stagedPhotoUpload.text());
  const stagedStorageBeforeDelete = await request(
    `/photo-upload-sessions/${stagedSession.result.uploadSession.id}/test-storage/${stagedPhotoId}`,
    { cookie: mainCookie }
  );
  assert.equal(stagedStorageBeforeDelete.result.objectCount, 3);
  const deletedDraft = await request(`/drafts/${deletableDraft.result.entry.id}`, {
    method: "DELETE", cookie: mainCookie, body: { revision: deletableDraft.result.entry.revision }
  });
  assert.equal(deletedDraft.response.status, 200, JSON.stringify(deletedDraft.result));
  assert.equal(deletedDraft.result.cleanupPending, false);
  const stagedStorageAfterDelete = await request(
    `/photo-upload-sessions/${stagedSession.result.uploadSession.id}/test-storage/${stagedPhotoId}`,
    { cookie: mainCookie }
  );
  assert.equal(stagedStorageAfterDelete.result.objectCount, 0, "draft deletion must remove staged upload objects");
  assert.equal((await request("/entries?draft=1", { cookie: mainCookie })).result.entries.some(
    (entry) => entry.id === deletableDraft.result.entry.id
  ), false);
  assert.equal((await request("/meta", { cookie: mainCookie })).result.draftCount, metaBeforePost.result.draftCount);

  const conflictDraft = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: { entryDate: "2026-08-17", title: `${marker}-conflict`, content: "競合前", tags: [], status: "draft" }
  });
  const conflictUpdated = await request(`/entries/${conflictDraft.result.entry.id}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-17", title: `${marker}-conflict`, content: "競合後", tags: [], status: "draft",
      revision: conflictDraft.result.entry.revision
    }
  });
  assert.equal(conflictUpdated.response.status, 200, JSON.stringify(conflictUpdated.result));
  const staleDelete = await request(`/drafts/${conflictDraft.result.entry.id}`, {
    method: "DELETE", cookie: mainCookie, body: { revision: conflictDraft.result.entry.revision }
  });
  assert.equal(staleDelete.response.status, 409);
  assert.equal((await request(`/entries/${conflictDraft.result.entry.id}`, { cookie: mainCookie })).response.status, 200);
  const currentDelete = await request(`/drafts/${conflictDraft.result.entry.id}`, {
    method: "DELETE", cookie: mainCookie, body: { revision: conflictUpdated.result.entry.revision }
  });
  assert.equal(currentDelete.response.status, 200, JSON.stringify(currentDelete.result));

  const photoId = randomUUID();
  const form = new FormData();
  form.set("id", photoId);
  form.set("width", "1");
  form.set("height", "1");
  form.set("original", new File([new Uint8Array([1, 2, 3])], `${marker}.png`, { type: "image/png" }));
  form.set("display", new File([new Uint8Array([4, 5])], "display.webp", { type: "image/webp" }));
  form.set("thumbnail", new File([new Uint8Array([6])], "thumbnail.webp", { type: "image/webp" }));
  const photoResponse = await fetch(`${origin}/diary/api/entries/${draftId}/photos`, {
    method: "POST", headers: { Cookie: mainCookie, "X-Diary-Request": "1" }, body: form
  });
  assert.equal(photoResponse.status, 200, await photoResponse.text());
  const rollBeforePost = await request(`/photos?entryQuery=${encodeURIComponent(marker)}`, { cookie: mainCookie });
  assert.equal(rollBeforePost.result.photos.length, 0);

  const draftUpdated = await request(`/entries/${draftId}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-15", title: `${marker}-draft`,
      content: `下書き本文\n[[写真:${photoId}]]`, tags: [hiddenTag],
      status: "draft", revision: draft.result.entry.revision
    }
  });
  assert.equal(draftUpdated.response.status, 200, JSON.stringify(draftUpdated.result));
  const promoted = await request(`/entries/${draftId}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-15", title: `${marker}-draft`,
      content: `下書き本文\n[[写真:${photoId}]]`, tags: [hiddenTag],
      status: "published", revision: draftUpdated.result.entry.revision
    }
  });
  assert.equal(promoted.response.status, 200, JSON.stringify(promoted.result));
  assert.equal(promoted.result.entry.id, draftId);
  assert.equal(promoted.result.entry.status, "published");
  assert.equal((await request("/entries?draft=1", { cookie: mainCookie })).result.entries.some((entry) => entry.id === draftId), false);
  assert.equal((await request(`/photos?entryQuery=${encodeURIComponent(marker)}`, { cookie: mainCookie })).result.photos.some((photo) => photo.id === photoId), true);
  assert.equal((await request("/meta", { cookie: mainCookie })).result.tags.some((tag) => tag.value === hiddenTag), true);

  const editDraft = await request(`/entries/${published.result.entry.id}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-15", title: `${marker}-edited`, content: "編集中の本文", tags: [editTag],
      status: "draft", revision: published.result.entry.revision
    }
  });
  assert.equal(editDraft.response.status, 200, JSON.stringify(editDraft.result));
  assert.equal(editDraft.result.entry.status, "draft");
  assert.equal(editDraft.result.entry.draftOfEntryId, published.result.entry.id);
  assert.notEqual(editDraft.result.entry.id, published.result.entry.id);
  const unchangedSource = await request(`/entries/${published.result.entry.id}`, { cookie: mainCookie });
  assert.equal(unchangedSource.result.entry.title, `${marker}-published`);

  const editPromoted = await request(`/entries/${editDraft.result.entry.id}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-15", title: `${marker}-edited`, content: "編集中の本文", tags: [editTag],
      status: "published", revision: editDraft.result.entry.revision
    }
  });
  assert.equal(editPromoted.response.status, 200, JSON.stringify(editPromoted.result));
  assert.equal(editPromoted.result.entry.id, published.result.entry.id);
  assert.equal(editPromoted.result.entry.title, `${marker}-edited`);
  assert.equal((await request("/entries?draft=1", { cookie: mainCookie })).result.entries.some((entry) => entry.id === editDraft.result.entry.id), false);
  const editedMatches = await request(`/entries?q=${encodeURIComponent(`${marker}-edited`)}`, { cookie: mainCookie });
  assert.equal(editedMatches.result.entries.filter((entry) => entry.id === published.result.entry.id).length, 1);

  const sourceForDeletedEdit = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: {
      entryDate: "2026-08-18", title: `${marker}-source-preserved`, content: "元記事の本文",
      tags: [editTag, "元記事タグ"]
    }
  });
  assert.equal(sourceForDeletedEdit.response.status, 200, JSON.stringify(sourceForDeletedEdit.result));
  const sourcePhotoId = randomUUID();
  const sourcePhotoForm = new FormData();
  sourcePhotoForm.set("id", sourcePhotoId);
  sourcePhotoForm.set("width", "2");
  sourcePhotoForm.set("height", "3");
  sourcePhotoForm.set("original", new File([new Uint8Array([11, 12, 13])], "source.png", { type: "image/png" }));
  sourcePhotoForm.set("display", new File([new Uint8Array([14, 15])], "display.webp", { type: "image/webp" }));
  sourcePhotoForm.set("thumbnail", new File([new Uint8Array([16])], "thumbnail.webp", { type: "image/webp" }));
  const sourcePhotoUpload = await fetch(`${origin}/diary/api/entries/${sourceForDeletedEdit.result.entry.id}/photos`, {
    method: "POST", headers: { Cookie: mainCookie, "X-Diary-Request": "1" }, body: sourcePhotoForm
  });
  assert.equal(sourcePhotoUpload.status, 200, await sourcePhotoUpload.text());
  const sourceBeforeDeletedEdit = (await request(`/entries/${sourceForDeletedEdit.result.entry.id}`, {
    cookie: mainCookie
  })).result.entry;

  const deletedEditDraft = await request(`/entries/${sourceForDeletedEdit.result.entry.id}`, {
    method: "PUT", cookie: mainCookie,
    body: {
      entryDate: "2026-08-19", title: `${marker}-source-edited-draft`, content: "削除予定の編集本文",
      tags: ["編集下書きタグ"], status: "draft", revision: sourceBeforeDeletedEdit.revision
    }
  });
  assert.equal(deletedEditDraft.response.status, 200, JSON.stringify(deletedEditDraft.result));
  assert.equal(deletedEditDraft.result.entry.draftOfEntryId, sourceForDeletedEdit.result.entry.id);
  const draftOnlyPhotoId = randomUUID();
  const draftPhotoForm = new FormData();
  draftPhotoForm.set("id", draftOnlyPhotoId);
  draftPhotoForm.set("width", "4");
  draftPhotoForm.set("height", "5");
  draftPhotoForm.set("original", new File([new Uint8Array([21, 22, 23])], "draft.png", { type: "image/png" }));
  draftPhotoForm.set("display", new File([new Uint8Array([24, 25])], "display.webp", { type: "image/webp" }));
  draftPhotoForm.set("thumbnail", new File([new Uint8Array([26])], "thumbnail.webp", { type: "image/webp" }));
  const draftPhotoUpload = await fetch(`${origin}/diary/api/entries/${deletedEditDraft.result.entry.id}/photos`, {
    method: "POST", headers: { Cookie: mainCookie, "X-Diary-Request": "1" }, body: draftPhotoForm
  });
  assert.equal(draftPhotoUpload.status, 200, await draftPhotoUpload.text());
  const countBeforeEditDraftDelete = (await request("/meta", { cookie: mainCookie })).result.draftCount;
  const editDraftDelete = await request(`/drafts/${deletedEditDraft.result.entry.id}`, {
    method: "DELETE", cookie: mainCookie, body: { revision: deletedEditDraft.result.entry.revision }
  });
  assert.equal(editDraftDelete.response.status, 200, JSON.stringify(editDraftDelete.result));
  assert.equal((await request("/meta", { cookie: mainCookie })).result.draftCount, countBeforeEditDraftDelete - 1);
  assert.equal((await request(`/entries/${deletedEditDraft.result.entry.id}`, { cookie: mainCookie })).response.status, 404);
  const sourceAfterDeletedEdit = (await request(`/entries/${sourceForDeletedEdit.result.entry.id}`, {
    cookie: mainCookie
  })).result.entry;
  for (const field of ["entryDate", "title", "content", "lastPublishedAt", "revision"]) {
    assert.deepEqual(sourceAfterDeletedEdit[field], sourceBeforeDeletedEdit[field], `source ${field} must remain unchanged`);
  }
  assert.deepEqual(sourceAfterDeletedEdit.tags, sourceBeforeDeletedEdit.tags);
  assert.deepEqual(sourceAfterDeletedEdit.photos, sourceBeforeDeletedEdit.photos);
  assert.equal((await fetch(`${origin}/diary/api/photos/${sourcePhotoId}/original`, {
    headers: { Cookie: mainCookie }
  })).status, 200, "source photo must remain available");
  assert.equal((await fetch(`${origin}/diary/api/photos/${draftOnlyPhotoId}/original`, {
    headers: { Cookie: mainCookie }
  })).status, 404, "draft-owned photo must be removed");

  const trashRegression = await request("/entries", {
    method: "POST", cookie: mainCookie,
    body: { entryDate: "2026-08-20", title: `${marker}-trash-regression`, content: "ゴミ箱回帰", tags: [] }
  });
  const trashed = await request(`/entries/${trashRegression.result.entry.id}`, {
    method: "DELETE", cookie: mainCookie, body: { revision: trashRegression.result.entry.revision }
  });
  assert.equal(trashed.response.status, 200, JSON.stringify(trashed.result));
  assert.equal((await request(`/entries?trash=1&q=${encodeURIComponent(`${marker}-trash-regression`)}`, {
    cookie: mainCookie
  })).result.entries.some((entry) => entry.id === trashRegression.result.entry.id), true);

  process.stdout.write("Diary draft lifecycle and isolation integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
