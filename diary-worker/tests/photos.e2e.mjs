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
  "--test-scheduled",
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
  "SESSION_SECRET:diary-photo-integration-test-session-secret",
  "--var",
  "STAGED_PHOTO_CLEANUP_TEST_PAUSE_MS:2000"
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

function createPhotoForm({ id, fileName, width = 1200, height = 800 }) {
  const form = new FormData();
  form.set("id", id);
  form.set("width", String(width));
  form.set("height", String(height));
  form.set("original", new File([new Uint8Array([1, 2, 3, 4])], fileName, { type: "image/png" }));
  form.set("display", new File([new Uint8Array([5, 6, 7])], "display.webp", { type: "image/webp" }));
  form.set("thumbnail", new File([new Uint8Array([8, 9])], "thumbnail.webp", { type: "image/webp" }));
  return form;
}

function countServerOutput(pattern) {
  return [...serverOutput.matchAll(pattern)].length;
}

try {
  await waitForServer();
  const wifeCookie = await login("wife@example.test", "wife-test");
  const mainCookie = await login("main@example.test", "main-test");

  const stagedPhotoId = randomUUID();
  const uploadSessionCreated = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: null }
  });
  assert.equal(uploadSessionCreated.response.status, 200, JSON.stringify(uploadSessionCreated.result));
  const uploadSessionId = uploadSessionCreated.result.uploadSession.id;
  const stagedUploadResponse = await fetch(`${origin}/diary/api/photo-upload-sessions/${uploadSessionId}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: stagedPhotoId, fileName: "preuploaded.png" })
  });
  const stagedUpload = await stagedUploadResponse.json();
  assert.equal(stagedUploadResponse.status, 200, JSON.stringify(stagedUpload));
  assert.equal(stagedUpload.photo.id, stagedPhotoId);
  assert.deepEqual(queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_staged_photos WHERE id = '${stagedPhotoId}') AS staged_count,
      (SELECT COUNT(*) FROM diary_photos WHERE id = '${stagedPhotoId}') AS final_count
  `).map((row) => ({ staged: Number(row.staged_count), final: Number(row.final_count) })), [{ staged: 1, final: 0 }],
  "preuploaded photo must remain outside the formal photo library");
  const stagedRoll = await jsonRequest(`/photos?fileName=preuploaded`, { cookie: wifeCookie });
  assert.equal(stagedRoll.result.photos.some((photo) => photo.id === stagedPhotoId), false,
    "staged photo must not appear in the camera roll");

  const stagedEntry = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "先行アップロード確認",
      content: `本文\n[[写真:${stagedPhotoId}]]`,
      tags: ["先行アップロード"]
    }
  });
  assert.equal(stagedEntry.response.status, 200, JSON.stringify(stagedEntry.result));
  const unauthorizedCommit = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie: mainCookie,
    body: { entryId: stagedEntry.result.entry.id, photoIds: [stagedPhotoId] }
  });
  assert.equal(unauthorizedCommit.response.status, 404, "another account in the same household must not commit staged photos");
  const stagedCommit = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie: wifeCookie,
    body: { entryId: stagedEntry.result.entry.id, photoIds: [stagedPhotoId] }
  });
  assert.equal(stagedCommit.response.status, 200, JSON.stringify(stagedCommit.result));
  assert.equal(stagedCommit.result.photos[0].entryId, stagedEntry.result.entry.id);
  const stagedCommitRetry = await jsonRequest(`/photo-upload-sessions/${uploadSessionId}/commit`, {
    method: "POST",
    cookie: wifeCookie,
    body: { entryId: stagedEntry.result.entry.id, photoIds: [stagedPhotoId] }
  });
  assert.equal(stagedCommitRetry.response.status, 200, JSON.stringify(stagedCommitRetry.result));
  assert.equal(stagedCommitRetry.result.idempotent, true, "lost commit response retry must remain idempotent");
  assert.deepEqual(queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_staged_photos WHERE id = '${stagedPhotoId}') AS staged_count,
      (SELECT COUNT(*) FROM diary_photos WHERE id = '${stagedPhotoId}' AND entry_id = ${stagedEntry.result.entry.id}) AS final_count
  `).map((row) => ({ staged: Number(row.staged_count), final: Number(row.final_count) })), [{ staged: 0, final: 1 }],
  "commit must promote exactly one photo ledger row");

  const partialSession = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: null }
  });
  const partialSessionId = partialSession.result.uploadSession.id;
  const partialPhotoIds = [randomUUID(), randomUUID()];
  for (const [index, partialPhotoId] of partialPhotoIds.entries()) {
    const response = await fetch(`${origin}/diary/api/photo-upload-sessions/${partialSessionId}/photos`, {
      method: "POST",
      headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
      body: createPhotoForm({ id: partialPhotoId, fileName: `partial-${index}.png` })
    });
    assert.equal(response.status, 200, await response.text());
  }
  const partialEntry = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "部分成功復旧確認",
      content: partialPhotoIds.map((id) => `[[写真:${id}]]`).join("\n"),
      tags: []
    }
  });
  queryLocalDatabase(`
    INSERT INTO diary_photos (
      id, entry_id, file_name, content_type, original_size,
      original_key, display_key, thumbnail_key, width, height,
      created_by_id, created_by_name, created_at
    )
    SELECT id, ${partialEntry.result.entry.id}, file_name, content_type, original_size,
           original_key, display_key, thumbnail_key, width, height,
           account_id, created_by_name, created_at
    FROM diary_staged_photos
    WHERE upload_session_id = '${partialSessionId}' AND id = '${partialPhotoIds[0]}'
  `);
  const recoveredPartialCommit = await jsonRequest(`/photo-upload-sessions/${partialSessionId}/commit`, {
    method: "POST",
    cookie: wifeCookie,
    body: { entryId: partialEntry.result.entry.id, photoIds: partialPhotoIds }
  });
  assert.equal(recoveredPartialCommit.response.status, 200, JSON.stringify(recoveredPartialCommit.result));
  const recoveredPartialState = queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_photos WHERE entry_id = ${partialEntry.result.entry.id}
        AND id IN ('${partialPhotoIds.join("', '")}')) AS final_count,
      (SELECT COUNT(*) FROM diary_staged_photos WHERE upload_session_id = '${partialSessionId}') AS staged_count,
      (SELECT status FROM diary_photo_upload_sessions WHERE id = '${partialSessionId}') AS session_status,
      (SELECT committed_photo_ids FROM diary_photo_upload_sessions WHERE id = '${partialSessionId}') AS committed_photo_ids
  `)[0];
  assert.equal(Number(recoveredPartialState.final_count), 2, "partial promotion retry must produce every final photo exactly once");
  assert.equal(Number(recoveredPartialState.staged_count), 0, "staging ledger must be removed only after commit is established");
  assert.equal(recoveredPartialState.session_status, "committed");
  assert.equal(recoveredPartialState.committed_photo_ids, JSON.stringify(partialPhotoIds));
  for (const photo of recoveredPartialCommit.result.photos) {
    const image = await fetch(`${origin}${photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
    assert.equal(image.status, 200, "promoted R2 object must remain readable");
  }

  queryLocalDatabase(`
    INSERT INTO diary_staged_photos (
      id, upload_session_id, household_id, account_id, file_name, content_type, original_size,
      original_key, display_key, thumbnail_key, width, height, created_by_name, created_at
    )
    SELECT photo.id, '${partialSessionId}', upload_session.household_id, upload_session.account_id,
           photo.file_name, photo.content_type, photo.original_size,
           photo.original_key, photo.display_key, photo.thumbnail_key, photo.width, photo.height,
           photo.created_by_name, photo.created_at
    FROM diary_photos photo
    JOIN diary_photo_upload_sessions upload_session ON upload_session.id = '${partialSessionId}'
    WHERE photo.id = '${partialPhotoIds[0]}'
  `);
  const promotedLedgerCleanup = await fetch(`${origin}/__scheduled?cron=25+18+*+*+*`);
  assert.equal(promotedLedgerCleanup.status, 200, await promotedLedgerCleanup.text());
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_staged_photos WHERE upload_session_id = '${partialSessionId}'`)[0].count), 0,
    "scheduled cleanup must remove a leftover promoted staging ledger");
  const promotedObjectAfterCleanup = await fetch(`${origin}${recoveredPartialCommit.result.photos[0].displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(promotedObjectAfterCleanup.status, 200, "staging cleanup must never delete an object owned by diary_photos");

  const cleanupRacePhotoId = randomUUID();
  const cleanupRaceSession = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: null }
  });
  const cleanupRaceSessionId = cleanupRaceSession.result.uploadSession.id;
  const cleanupRaceUpload = await fetch(`${origin}/diary/api/photo-upload-sessions/${cleanupRaceSessionId}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: cleanupRacePhotoId, fileName: "cleanup-race.png" })
  });
  assert.equal(cleanupRaceUpload.status, 200, await cleanupRaceUpload.text());
  queryLocalDatabase(`UPDATE diary_photo_upload_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${cleanupRaceSessionId}'`);
  const cleanupPauseCount = countServerOutput(/Diary staged photo cleanup test pause/g);
  const cleanupRaceScheduled = await fetch(`${origin}/__scheduled?cron=25+18+*+*+*`);
  assert.equal(cleanupRaceScheduled.status, 200, await cleanupRaceScheduled.text());
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (countServerOutput(/Diary staged photo cleanup test pause/g) > cleanupPauseCount) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(countServerOutput(/Diary staged photo cleanup test pause/g) > cleanupPauseCount,
    "scheduled cleanup must select the expired candidate before its simulated upload extends TTL");
  const cleanupRaceExtension = await jsonRequest(`/photo-upload-sessions/${cleanupRaceSessionId}/test-extend`, {
    method: "POST",
    cookie: wifeCookie
  });
  assert.equal(cleanupRaceExtension.response.status, 200, JSON.stringify(cleanupRaceExtension.result));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const cleanupRaceState = queryLocalDatabase(`
    SELECT
      (SELECT COUNT(*) FROM diary_photo_upload_sessions WHERE id = '${cleanupRaceSessionId}' AND status = 'active') AS session_count,
      (SELECT COUNT(*) FROM diary_staged_photos WHERE id = '${cleanupRacePhotoId}') AS staged_count
  `)[0];
  assert.equal(Number(cleanupRaceState.session_count), 1, "a TTL extension after candidate selection must preserve the active session");
  assert.equal(Number(cleanupRaceState.staged_count), 1, "a TTL extension after candidate selection must preserve the staged ledger and R2 ownership");
  const cleanupRaceEntry = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "cleanup競合確認",
      content: `[[写真:${cleanupRacePhotoId}]]`,
      tags: []
    }
  });
  const cleanupRaceCommit = await jsonRequest(`/photo-upload-sessions/${cleanupRaceSessionId}/commit`, {
    method: "POST",
    cookie: wifeCookie,
    body: { entryId: cleanupRaceEntry.result.entry.id, photoIds: [cleanupRacePhotoId] }
  });
  assert.equal(cleanupRaceCommit.response.status, 200, JSON.stringify(cleanupRaceCommit.result));
  const cleanupRaceImage = await fetch(`${origin}${cleanupRaceCommit.result.photos[0].displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(cleanupRaceImage.status, 200, "the preserved race candidate must remain committable with its R2 object");

  const editDraftPhotoId = randomUUID();
  const editSource = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "編集下書き写真確認",
      content: "公開本文",
      tags: ["編集下書き"]
    }
  });
  assert.equal(editSource.response.status, 200, JSON.stringify(editSource.result));
  const editUploadSession = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: editSource.result.entry.id }
  });
  const editUploadSessionId = editUploadSession.result.uploadSession.id;
  const editStagedResponse = await fetch(`${origin}/diary/api/photo-upload-sessions/${editUploadSessionId}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: editDraftPhotoId, fileName: "edit-draft.png" })
  });
  assert.equal(editStagedResponse.status, 200, await editStagedResponse.text());
  const editDraft = await jsonRequest(`/entries/${editSource.result.entry.id}`, {
    method: "PUT",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "編集下書き写真確認",
      content: `編集本文\n[[写真:${editDraftPhotoId}]]`,
      tags: ["編集下書き"],
      status: "draft",
      revision: editSource.result.entry.revision,
      excludedPhotoIds: []
    }
  });
  assert.equal(editDraft.response.status, 200, JSON.stringify(editDraft.result));
  assert.notEqual(editDraft.result.entry.id, editSource.result.entry.id);
  const editDraftCommit = await jsonRequest(`/photo-upload-sessions/${editUploadSessionId}/commit`, {
    method: "POST",
    cookie: wifeCookie,
    body: { entryId: editDraft.result.entry.id, photoIds: [editDraftPhotoId] }
  });
  assert.equal(editDraftCommit.response.status, 200, JSON.stringify(editDraftCommit.result));
  const publishedEditDraft = await jsonRequest(`/entries/${editDraft.result.entry.id}`, {
    method: "PUT",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-09",
      title: "編集下書き写真確認",
      content: `編集本文\n[[写真:${editDraftPhotoId}]]`,
      tags: ["編集下書き"],
      status: "published",
      revision: editDraft.result.entry.revision,
      excludedPhotoIds: []
    }
  });
  assert.equal(publishedEditDraft.response.status, 200, JSON.stringify(publishedEditDraft.result));
  assert.equal(publishedEditDraft.result.entry.id, editSource.result.entry.id);
  assert.equal(publishedEditDraft.result.entry.photos.some((photo) => photo.id === editDraftPhotoId), true,
    "staged photo committed to an edit draft must move to the published source");

  const cancelledPhotoId = randomUUID();
  const cancelledSession = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: null }
  });
  const cancelledSessionId = cancelledSession.result.uploadSession.id;
  const cancelledUploadResponse = await fetch(`${origin}/diary/api/photo-upload-sessions/${cancelledSessionId}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: cancelledPhotoId, fileName: "cancelled.png" })
  });
  assert.equal(cancelledUploadResponse.status, 200, await cancelledUploadResponse.text());
  const cancelled = await jsonRequest(`/photo-upload-sessions/${cancelledSessionId}`, {
    method: "DELETE",
    cookie: wifeCookie
  });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.result));
  assert.equal(Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_staged_photos WHERE upload_session_id = '${cancelledSessionId}'`)[0].count), 0,
    "discarded editor photos must be removed from staging");

  const expiredPhotoId = randomUUID();
  const expiredSession = await jsonRequest("/photo-upload-sessions", {
    method: "POST",
    cookie: wifeCookie,
    body: { targetEntryId: null }
  });
  const expiredSessionId = expiredSession.result.uploadSession.id;
  const expiredUploadResponse = await fetch(`${origin}/diary/api/photo-upload-sessions/${expiredSessionId}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: expiredPhotoId, fileName: "expired.png" })
  });
  assert.equal(expiredUploadResponse.status, 200, await expiredUploadResponse.text());
  queryLocalDatabase(`UPDATE diary_photo_upload_sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${expiredSessionId}'`);
  const scheduled = await fetch(`${origin}/__scheduled?cron=25+18+*+*+*`);
  assert.equal(scheduled.status, 200, await scheduled.text());
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_staged_photos WHERE upload_session_id = '${expiredSessionId}'`)[0].count);
    if (!remaining) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_staged_photos WHERE upload_session_id = '${expiredSessionId}'`)[0].count), 0,
    "scheduled cleanup must remove expired uncommitted photos");
  assert.equal(Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_photo_upload_sessions WHERE id = '${expiredSessionId}'`)[0].count), 0,
    "scheduled cleanup must remove the expired upload session");

  const photoId = randomUUID();
  const marker = photoId.slice(0, 8);
  const tagToken = `旅行タグ${marker}`;
  const titleToken = `京都題名${marker}`;
  const contentToken = `清水寺本文${marker}`;
  const fileNameToken = `IMG_${marker}`;
  const created = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-10",
      title: `${titleToken}-photo-test-${photoId}`,
      content: `${contentToken}の記録\n[[写真:${photoId}]]`,
      tags: [tagToken, `${tagToken}追加`]
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  const entry = created.result.entry;

  const form = createPhotoForm({ id: photoId, fileName: `${fileNameToken}.png` });
  const uploadResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: form
  });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 200, JSON.stringify(upload));
  assert.equal(upload.photo.id, photoId);

  const idempotentRetryResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: photoId, fileName: `${fileNameToken}.png` })
  });
  const idempotentRetry = await idempotentRetryResponse.json();
  assert.equal(idempotentRetryResponse.status, 200, JSON.stringify(idempotentRetry));
  assert.equal(idempotentRetry.idempotent, true, "lost success response retry must be accepted as already completed");
  assert.equal(idempotentRetry.photo.id, photoId);
  assert.equal(Number(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_photos WHERE id = '${photoId}'`)[0].count), 1,
    "idempotent retry must retain exactly one photo ledger row");

  const mismatchedPhotoRetryResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: photoId, fileName: `different-${fileNameToken}.png` })
  });
  assert.equal(mismatchedPhotoRetryResponse.status, 409, "same photo ID with different metadata must not be accepted");

  const otherEntryCreated = await jsonRequest("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: {
      entryDate: "2026-08-10",
      title: `other-entry-${photoId}`,
      content: "別の日記",
      tags: []
    }
  });
  assert.equal(otherEntryCreated.response.status, 200, JSON.stringify(otherEntryCreated.result));
  const otherEntryRetryResponse = await fetch(`${origin}/diary/api/entries/${otherEntryCreated.result.entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: wifeCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: photoId, fileName: `${fileNameToken}.png` })
  });
  assert.equal(otherEntryRetryResponse.status, 409, "same photo ID must not be accepted for another entry");

  const otherAccountRetryResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: mainCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: photoId, fileName: `${fileNameToken}.png` })
  });
  assert.equal(otherAccountRetryResponse.status, 409, "another account must not claim an existing photo upload as its retry");
  const householdSwitch = await jsonRequest("/households/select", {
    method: "POST",
    cookie: mainCookie,
    body: { householdId: "chiharu-household" }
  });
  assert.equal(householdSwitch.response.status, 200, JSON.stringify(householdSwitch.result));
  const chiharuCookie = householdSwitch.response.headers.get("set-cookie").split(";", 1)[0];
  const otherHouseholdRetryResponse = await fetch(`${origin}/diary/api/entries/${entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: chiharuCookie, "X-Diary-Request": "1" },
    body: createPhotoForm({ id: photoId, fileName: `${fileNameToken}.png` })
  });
  assert.equal(otherHouseholdRetryResponse.status, 404, "another household must not access the entry or reuse its photo ID");

  const detailed = await jsonRequest(`/entries/${entry.id}`, { cookie: wifeCookie });
  assert.equal(detailed.response.status, 200);
  assert.equal(detailed.result.entry.photos.length, 1);
  assert.equal(detailed.result.entry.photos[0].fileName, `${fileNameToken}.png`);

  async function matchingPhotoIds(parameters) {
    const result = await jsonRequest(`/photos?${new URLSearchParams(parameters)}`, { cookie: wifeCookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.result));
    return result.result.photos.map((photo) => photo.id);
  }

  assert.deepEqual(await matchingPhotoIds({ entryQuery: tagToken }), [photoId], "tag-only match must find the photo once");
  assert.deepEqual(await matchingPhotoIds({ entryQuery: titleToken }), [photoId], "title-only match must find the photo");
  assert.deepEqual(await matchingPhotoIds({ entryQuery: contentToken }), [photoId], "content-only match must find the photo");
  assert.deepEqual(await matchingPhotoIds({ entryQuery: `該当なし${marker}` }), [], "unmatched entry query must hide the photo");
  assert.deepEqual(await matchingPhotoIds({ fileName: fileNameToken }), [photoId], "file-name match must find the photo");
  assert.deepEqual(await matchingPhotoIds({ fileName: titleToken }), [], "title must not match the file-name filter");
  assert.deepEqual(await matchingPhotoIds({ fileName: contentToken }), [], "content must not match the file-name filter");
  assert.deepEqual(await matchingPhotoIds({ fileName: tagToken }), [], "tag must not match the file-name filter");
  assert.deepEqual(await matchingPhotoIds({ entryQuery: tagToken, month: "2026-08" }), [photoId]);
  assert.deepEqual(await matchingPhotoIds({ entryQuery: titleToken, fileName: fileNameToken }), [photoId]);
  assert.deepEqual(await matchingPhotoIds({ month: "2026-08", fileName: fileNameToken }), [photoId]);
  assert.deepEqual(await matchingPhotoIds({ entryQuery: contentToken, month: "2026-08", fileName: fileNameToken }), [photoId]);
  assert.deepEqual(await matchingPhotoIds({ entryQuery: tagToken, month: "2026-07", fileName: fileNameToken }), []);

  const photoMeta = await jsonRequest("/photos/meta", { cookie: wifeCookie });
  assert.equal(photoMeta.response.status, 200);
  assert.ok(photoMeta.result.months.some((item) => item.value === "2026-08"));
  assert.equal("authors" in photoMeta.result, false, "photo meta must not expose the removed author filter");
  const imageResponse = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/webp");

  const deletablePhotoId = randomUUID();
  const deletableForm = new FormData();
  deletableForm.set("id", deletablePhotoId);
  deletableForm.set("width", "640");
  deletableForm.set("height", "480");
  deletableForm.set("original", new File([new Uint8Array([10, 11, 12])], `delete-${deletablePhotoId}.png`, { type: "image/png" }));
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
  const rollAfterPhotoDelete = await jsonRequest(`/photos?fileName=${encodeURIComponent(deletablePhotoId)}`, { cookie: wifeCookie });
  assert.equal(rollAfterPhotoDelete.result.photos.some((photo) => photo.id === deletablePhotoId), false);

  const moved = await jsonRequest(`/entries/${entry.id}`, {
    method: "DELETE",
    cookie: wifeCookie,
    body: { revision: detailed.result.entry.revision }
  });
  assert.equal(moved.response.status, 200);
  const visibleInWifeTrash = await fetch(`${origin}${upload.photo.displayUrl}`, { headers: { Cookie: wifeCookie } });
  assert.equal(visibleInWifeTrash.status, 200);

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
