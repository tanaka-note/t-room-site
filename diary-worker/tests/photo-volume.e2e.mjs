import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8811;
const origin = `http://127.0.0.1:${port}`;
const persistDirectory = mkdtempSync(join(tmpdir(), "troom-diary-photo-volume-"));

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

const migration = spawnSync(process.execPath, [
  wranglerPath, "d1", "migrations", "apply", "diary-db", "--local", "--persist-to", persistDirectory
], {
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
  "--persist-to",
  persistDirectory,
  "--var",
  "DIARY_MAIN_ADMIN_LOGIN_ID:main-volume@example.test",
  "--var",
  `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-volume-test")}`,
  "--var",
  "DIARY_WIFE_ADMIN_LOGIN_ID:wife-volume@example.test",
  "--var",
  `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-volume-test")}`,
  "--var",
  `SESSION_SECRET:${randomBytes(32).toString("hex")}`
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

function queryLocalDatabase(command) {
  const result = spawnSync(process.execPath, [
    wranglerPath,
    "d1",
    "execute",
    "diary-db",
    "--local",
    "--persist-to",
    persistDirectory,
    "--json",
    "--command",
    command
  ], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout)[0].results;
}

async function login() {
  const { response, result } = await jsonRequest("/login", {
    method: "POST",
    body: { loginId: "wife-volume@example.test", password: "wife-volume-test" }
  });
  assert.equal(response.status, 200, JSON.stringify(result));
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function createUploadSession(cookie, targetEntryId = null) {
  const created = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie,
    body: { targetEntryId }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  return created.result.uploadSession.id;
}

function insertStagedPhotoFixtures(uploadSessionId, photoIds) {
  for (let offset = 0; offset < photoIds.length; offset += 80) {
    const values = photoIds.slice(offset, offset + 80).map((id, index) => {
      const ordinal = offset + index;
      return `('${id}', ${ordinal}, '${randomUUID()}')`;
    }).join(",");
    queryLocalDatabase(`
      WITH fixtures(id, ordinal, attempt_id) AS (VALUES ${values})
      INSERT INTO diary_staged_photos (
        id, upload_session_id, household_id, account_id, file_name, content_type, original_size,
        original_key, display_key, thumbnail_key, width, height, created_by_name, created_at
      )
      SELECT fixtures.id, session.id, session.household_id, session.account_id,
             'volume-' || fixtures.ordinal || '.png', 'image/png', 4,
             'diary/staging/' || session.household_id || '/' || session.id || '/' || fixtures.id || '/' || fixtures.attempt_id || '/original',
             'diary/staging/' || session.household_id || '/' || session.id || '/' || fixtures.id || '/' || fixtures.attempt_id || '/display',
             'diary/staging/' || session.household_id || '/' || session.id || '/' || fixtures.id || '/' || fixtures.attempt_id || '/thumbnail',
             1200, 800, '写真件数テスト', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM fixtures
      JOIN diary_photo_upload_sessions session ON session.id = '${uploadSessionId}'
    `);
  }
}

function entryBody(photoIds, { status = "published", revision, requestId = randomUUID() } = {}) {
  const body = {
    entryDate: "2026-09-24",
    title: `写真${photoIds.length}枚テスト`,
    content: "写真保存の件数境界を確認します。",
    tags: ["写真件数"],
    status,
    pendingPhotoIds: photoIds,
    photoUploadSessionId: null,
    requestId
  };
  if (revision != null) body.revision = revision;
  return body;
}

async function createAndCommitPhotos(cookie, count, status = "published") {
  const photoIds = Array.from({ length: count }, () => randomUUID());
  const uploadSessionId = await createUploadSession(cookie);
  insertStagedPhotoFixtures(uploadSessionId, photoIds);
  const body = entryBody(photoIds, { status });
  body.photoUploadSessionId = uploadSessionId;
  const created = await jsonRequest("/entries", { method: "POST", cookie, body });
  assert.equal(created.response.status, 200, `${count} photos: ${JSON.stringify(created.result)}`);
  const entry = created.result.entry;
  if (count === 1) {
    const invalid = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
      method: "POST",
      cookie,
      body: { entryId: entry.id, photoIds: [...photoIds, "not-a-uuid"] }
    });
    assert.equal(invalid.response.status, 400, "invalid photo IDs must be rejected without consuming the upload session");
  }
  const committed = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: entry.id, photoIds }
  });
  assert.equal(committed.response.status, 200, `${count} photos: ${JSON.stringify(committed.result)}`);
  assert.equal(committed.result.photos.length, count, `${count} photos must all be returned after commit`);
  const retried = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: entry.id, photoIds }
  });
  assert.equal(retried.response.status, 200, `${count} photo retry: ${JSON.stringify(retried.result)}`);
  assert.equal(retried.result.idempotent, true, `${count} photo retry must be idempotent`);
  assert.equal(retried.result.photos.length, count, `${count} photo retry must return every photo`);
  const finalized = await jsonRequest(`/entries/${entry.id}`, {
    method: "PUT",
    cookie,
    body: {
      entryDate: entry.entryDate,
      title: entry.title,
      content: photoIds.map((id) => `[[写真:${id}]]`).join("\n"),
      contentFormat: null,
      tags: entry.tags,
      status,
      excludedPhotoIds: [],
      revision: entry.revision
    }
  });
  assert.equal(finalized.response.status, 200, `${count} photo finalize: ${JSON.stringify(finalized.result)}`);
  assert.equal(finalized.result.entry.photos.length, count, `${count} photos must survive finalization`);
  return { entry: finalized.result.entry, photoIds, uploadSessionId };
}

async function addPhotosToEntry(cookie, entry, count, status = entry.status) {
  const photoIds = Array.from({ length: count }, () => randomUUID());
  const uploadSessionId = await createUploadSession(cookie, entry.id);
  insertStagedPhotoFixtures(uploadSessionId, photoIds);
  const provisional = await jsonRequest(`/entries/${entry.id}`, {
    method: "PUT",
    cookie,
    body: {
      entryDate: entry.entryDate,
      title: entry.title,
      content: entry.content,
      contentFormat: entry.contentFormat,
      tags: entry.tags,
      status,
      excludedPhotoIds: entry.excludedPhotoIds || [],
      revision: entry.revision,
      pendingPhotoIds: photoIds,
      photoUploadSessionId: uploadSessionId
    }
  });
  assert.equal(provisional.response.status, 200, `${count} added photos: ${JSON.stringify(provisional.result)}`);
  const committed = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: provisional.result.entry.id, photoIds }
  });
  assert.equal(committed.response.status, 200, `${count} added photo commit: ${JSON.stringify(committed.result)}`);
  assert.equal(committed.result.photos.length, count);
  const finalContent = [entry.content, ...photoIds.map((id) => `[[写真:${id}]]`)].filter(Boolean).join("\n");
  const finalized = await jsonRequest(`/entries/${provisional.result.entry.id}`, {
    method: "PUT",
    cookie,
    body: {
      entryDate: provisional.result.entry.entryDate,
      title: provisional.result.entry.title,
      content: finalContent,
      contentFormat: null,
      tags: provisional.result.entry.tags,
      status,
      excludedPhotoIds: provisional.result.entry.excludedPhotoIds || [],
      revision: provisional.result.entry.revision
    }
  });
  assert.equal(finalized.response.status, 200, `${count} added photo finalize: ${JSON.stringify(finalized.result)}`);
  return finalized.result.entry;
}

try {
  await waitForServer();
  const cookie = await login();

  const boundaryEntries = new Map();
  for (const count of [1, 46, 47, 50, 100, 200, 201]) {
    boundaryEntries.set(count, await createAndCommitPhotos(cookie, count));
  }

  const largeDraft = await createAndCommitPhotos(cookie, 201, "draft");
  const draftDetail = await jsonRequest(`/entries/${largeDraft.entry.id}`, { cookie });
  assert.equal(draftDetail.response.status, 200, JSON.stringify(draftDetail.result));
  assert.equal(draftDetail.result.entry.status, "draft");
  assert.equal(draftDetail.result.entry.photos.length, 201, "a reopened large draft must retain every photo");
  const resavedDraft = await addPhotosToEntry(cookie, draftDetail.result.entry, 47, "draft");
  assert.equal(resavedDraft.status, "draft");
  assert.equal(resavedDraft.photos.length, 248, "reopened draft additions must be retained on another draft save");
  const publishedDraft = await addPhotosToEntry(cookie, resavedDraft, 50, "published");
  assert.equal(publishedDraft.status, "published");
  assert.equal(publishedDraft.photos.length, 298, "reopened draft additions must survive publication");

  const directlyEdited = await addPhotosToEntry(cookie, boundaryEntries.get(46).entry, 47, "published");
  assert.equal(directlyEdited.photos.length, 93, "published entry updates must retain existing and newly added photos");

  const editSource = boundaryEntries.get(50).entry;
  const editDraftCreated = await jsonRequest(`/entries/${editSource.id}`, {
    method: "PUT",
    cookie,
    body: {
      entryDate: editSource.entryDate,
      title: editSource.title,
      content: editSource.content,
      contentFormat: editSource.contentFormat,
      tags: editSource.tags,
      status: "draft",
      excludedPhotoIds: [],
      revision: editSource.revision
    }
  });
  assert.equal(editDraftCreated.response.status, 200, JSON.stringify(editDraftCreated.result));
  assert.notEqual(editDraftCreated.result.entry.id, editSource.id);
  const resavedEditDraft = await addPhotosToEntry(cookie, editDraftCreated.result.entry, 47, "draft");
  assert.equal(resavedEditDraft.status, "draft");
  assert.equal(resavedEditDraft.photos.length, 97, "reopened edit draft additions must be retained on draft save");
  const publishedEditDraft = await addPhotosToEntry(cookie, resavedEditDraft, 50, "published");
  assert.equal(publishedEditDraft.id, editSource.id, "publishing an edit draft must update its source entry");
  assert.equal(publishedEditDraft.photos.length, 147, "reopened edit draft additions must survive publication");

  const replaceSessionId = await createUploadSession(cookie);
  const initiallySelected = Array.from({ length: 201 }, () => randomUUID());
  insertStagedPhotoFixtures(replaceSessionId, initiallySelected);
  const removedId = initiallySelected[73];
  const removed = await jsonRequest(`/photo-upload-sessions/${replaceSessionId}/photos/${removedId}`, {
    method: "DELETE",
    cookie
  });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.result));
  const replacementId = randomUUID();
  insertStagedPhotoFixtures(replaceSessionId, [replacementId]);
  const finalSelection = initiallySelected.filter((id) => id !== removedId).concat(replacementId);
  const replacementBody = entryBody(finalSelection);
  replacementBody.photoUploadSessionId = replaceSessionId;
  replacementBody.pendingPhotoIds = [...finalSelection, finalSelection[0]];
  const replacementEntry = await jsonRequest("/entries", { method: "POST", cookie, body: replacementBody });
  assert.equal(replacementEntry.response.status, 200, JSON.stringify(replacementEntry.result));
  const replacementCommit = await jsonRequest(`/photo-upload-sessions/${replaceSessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: replacementEntry.result.entry.id, photoIds: [...finalSelection, finalSelection[0]] }
  });
  assert.equal(replacementCommit.response.status, 200, JSON.stringify(replacementCommit.result));
  assert.equal(replacementCommit.result.photos.length, 201, "add/remove/add must commit the final selection without truncation");
  assert.equal(replacementCommit.result.photos.some((photo) => photo.id === removedId), false);
  assert.equal(replacementCommit.result.photos.some((photo) => photo.id === replacementId), true);
  const replacementState = queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_photos WHERE entry_id = ${replacementEntry.result.entry.id}) AS final_count,
      (SELECT COUNT(*) FROM diary_photos WHERE id = '${removedId}') AS removed_count,
      (SELECT COUNT(*) FROM diary_staged_photos WHERE upload_session_id = '${replaceSessionId}') AS staged_count
  `)[0];
  assert.equal(Number(replacementState.final_count), 201);
  assert.equal(Number(replacementState.removed_count), 0);
  assert.equal(Number(replacementState.staged_count), 0, "successful commit must clean the staging ledger");

  const emptySessionId = await createUploadSession(cookie);
  const emptyEntry = await jsonRequest("/entries", {
    method: "POST",
    cookie,
    body: {
      entryDate: "2026-09-24",
      title: "写真をすべて取り除いた保存",
      content: "空の写真確定を確認します。",
      tags: [],
      status: "published",
      requestId: randomUUID()
    }
  });
  assert.equal(emptyEntry.response.status, 200, JSON.stringify(emptyEntry.result));
  const emptyCommit = await jsonRequest(`/photo-upload-sessions/${emptySessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: emptyEntry.result.entry.id, photoIds: [] }
  });
  assert.equal(emptyCommit.response.status, 200, JSON.stringify(emptyCommit.result));
  assert.deepEqual(emptyCommit.result.photos, []);
  const emptyRetry = await jsonRequest(`/photo-upload-sessions/${emptySessionId}/commit`, {
    method: "POST",
    cookie,
    body: { entryId: emptyEntry.result.entry.id, photoIds: [] }
  });
  assert.equal(emptyRetry.response.status, 200, JSON.stringify(emptyRetry.result));
  assert.equal(emptyRetry.result.idempotent, true);

  process.stdout.write("Diary photo volume integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  try { rmSync(persistDirectory, { recursive: true, force: true }); } catch {}
}
