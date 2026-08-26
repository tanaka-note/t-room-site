import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8820;
const origin = `http://127.0.0.1:${port}`;
const marker = `write-integrity-${randomUUID()}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

function testHmacHash(password) {
  return `hmac-sha256$${createHmac("sha256", "diary-write-integrity-session-secret").update(password).digest("base64url")}`;
}

function wrangler(...args) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], {
    cwd: projectDirectory,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

wrangler("d1", "migrations", "apply", "diary-db", "--local");
wrangler("d1", "execute", "diary-db", "--local", "--command", `
  DELETE FROM diary_entries WHERE instr(title, '${marker}') = 1;
  DELETE FROM diary_login_attempts;
  UPDATE diary_accounts
  SET password_hash = NULL, must_change_password = 1, session_version = session_version + 1
  WHERE id = 'chiharu-admin';
`);

const server = spawn(process.execPath, [
  wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", `DIARY_CHIHARU_TEMP_PASSWORD_HASH:${testHash("temporary-test")}`,
  "--var", "SESSION_SECRET:diary-write-integrity-session-secret",
  "--var", "DIARY_ATOMICITY_TESTS:true"
], { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${origin}/diary/api/session`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start.\n${output}`);
}

async function request(path, { method = "GET", body, cookie, atomicFailure } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers["X-Diary-Request"] = "1";
  if (atomicFailure) headers["X-Diary-Test-Atomic-Failure"] = atomicFailure;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${origin}/diary/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  return { response, result, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

async function login(loginId, password) {
  const result = await request("/login", { method: "POST", body: { loginId, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  return result.cookie;
}

function query(sql) {
  return JSON.parse(wrangler("d1", "execute", "diary-db", "--local", "--json", "--command", sql))[0].results;
}

function entryBody(title, overrides = {}) {
  return {
    requestId: randomUUID(),
    entryDate: "2026-08-25",
    title,
    content: `${title} 本文`,
    contentFormat: null,
    tags: ["write-integrity"],
    status: "published",
    excludedPhotoIds: [],
    ...overrides
  };
}

function rawJsonRequest(path, { cookie, bodyChunks, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port,
      path: `/diary/api${path}`,
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Diary-Request": "1",
        ...headers
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    for (const chunk of bodyChunks) request.write(chunk);
    request.end();
  });
}

function photoForm(id) {
  const form = new FormData();
  form.set("id", id);
  form.set("width", "4");
  form.set("height", "3");
  form.set("original", new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" }));
  form.set("display", new File([new Uint8Array([4, 5])], "display.webp", { type: "image/webp" }));
  form.set("thumbnail", new File([new Uint8Array([6])], "thumbnail.webp", { type: "image/webp" }));
  return form;
}

try {
  await waitForServer();
  const mainCookie = await login("main@example.test", "main-test");
  const wifeCookie = await login("wife@example.test", "wife-test");

  const temporaryCookie = await login("giantz3031@gmail.com", "temporary-test");
  const initialPassword = await request("/password/initial", {
    method: "POST",
    cookie: temporaryCookie,
    body: { password: "new-pbkdf2-password", confirmation: "new-pbkdf2-password" }
  });
  assert.equal(initialPassword.response.status, 200, JSON.stringify(initialPassword.result));
  const savedPbkdf2 = query("SELECT password_hash FROM diary_accounts WHERE id = 'chiharu-admin'")[0].password_hash;
  assert.match(savedPbkdf2, /^pbkdf2-sha256\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
    "new passwords must use a random 16-byte salt and a 32-byte PBKDF2-SHA256 hash");
  await login("giantz3031@gmail.com", "new-pbkdf2-password");
  wrangler("d1", "execute", "diary-db", "--local", "--command",
    "UPDATE diary_accounts SET password_hash = NULL, must_change_password = 1, session_version = session_version + 1 WHERE id = 'chiharu-admin'");
  const secondTemporaryCookie = await login("giantz3031@gmail.com", "temporary-test");
  const repeatedInitialPassword = await request("/password/initial", {
    method: "POST",
    cookie: secondTemporaryCookie,
    body: { password: "new-pbkdf2-password", confirmation: "new-pbkdf2-password" }
  });
  assert.equal(repeatedInitialPassword.response.status, 200, JSON.stringify(repeatedInitialPassword.result));
  const repeatedPbkdf2 = query("SELECT password_hash FROM diary_accounts WHERE id = 'chiharu-admin'")[0].password_hash;
  assert.notEqual(repeatedPbkdf2, savedPbkdf2, "the same password must receive a new cryptographically random salt");
  wrangler("d1", "execute", "diary-db", "--local", "--command",
    `UPDATE diary_accounts SET password_hash = '${testHash("legacy-upgrade")}', must_change_password = 0 WHERE id = 'chiharu-admin'`);
  await login("giantz3031@gmail.com", "legacy-upgrade");
  assert.match(query("SELECT password_hash FROM diary_accounts WHERE id = 'chiharu-admin'")[0].password_hash, /^pbkdf2-sha256\$600000\$/,
    "a successful legacy-password login must opportunistically upgrade the stored hash");
  wrangler("d1", "execute", "diary-db", "--local", "--command",
    `UPDATE diary_accounts SET password_hash = '${testHmacHash("legacy-hmac-upgrade")}' WHERE id = 'chiharu-admin'`);
  await login("giantz3031@gmail.com", "legacy-hmac-upgrade");
  assert.match(query("SELECT password_hash FROM diary_accounts WHERE id = 'chiharu-admin'")[0].password_hash, /^pbkdf2-sha256\$600000\$/,
    "legacy HMAC hashes must remain verifiable and upgrade after a successful login");

  const idempotencyKey = randomUUID();
  const idempotentBody = entryBody(`${marker}-idempotent`, { requestId: idempotencyKey, tags: ["alpha", "beta"] });
  const firstCreate = await request("/entries", { method: "POST", cookie: mainCookie, body: idempotentBody });
  assert.equal(firstCreate.response.status, 200, JSON.stringify(firstCreate.result));
  // Deliberately discard the first response from the application's point of view and repeat the exact request.
  const replayCreate = await request("/entries", { method: "POST", cookie: mainCookie, body: idempotentBody });
  assert.equal(replayCreate.response.status, 200, JSON.stringify(replayCreate.result));
  assert.equal(replayCreate.result.entry.id, firstCreate.result.entry.id);
  assert.deepEqual(replayCreate.result.entry.tags, ["alpha", "beta"]);
  const idempotentCounts = query(`
    SELECT
      (SELECT COUNT(*) FROM diary_entries WHERE household_id = 'tanaka-household' AND author_id = 'main-admin' AND client_request_id = '${idempotencyKey}') AS entry_count,
      (SELECT COUNT(*) FROM diary_tags WHERE entry_id = ${firstCreate.result.entry.id}) AS tag_count
  `)[0];
  assert.equal(Number(idempotentCounts.entry_count), 1);
  assert.equal(Number(idempotentCounts.tag_count), 2);

  const reorderedTags = await request("/entries", {
    method: "POST",
    cookie: mainCookie,
    body: { ...idempotentBody, tags: ["beta", "alpha"] }
  });
  assert.equal(reorderedTags.response.status, 409, "tag order is part of the idempotent create payload");
  assert.match(reorderedTags.result.error, /同じ送信ID/);

  const mismatch = await request("/entries", {
    method: "POST",
    cookie: mainCookie,
    body: { ...idempotentBody, title: `${marker}-different` }
  });
  assert.equal(mismatch.response.status, 409);
  assert.match(mismatch.result.error, /同じ送信ID/);

  const otherAccount = await request("/entries", {
    method: "POST",
    cookie: wifeCookie,
    body: entryBody(`${marker}-other-account`, { requestId: idempotencyKey })
  });
  assert.equal(otherAccount.response.status, 200, JSON.stringify(otherAccount.result));
  assert.notEqual(otherAccount.result.entry.id, firstCreate.result.entry.id, "request IDs must be scoped by account");
  const householdSelection = await request("/households/select", {
    method: "POST", cookie: mainCookie, body: { householdId: "chiharu-household" }
  });
  assert.equal(householdSelection.response.status, 200, JSON.stringify(householdSelection.result));
  const otherHousehold = await request("/entries", {
    method: "POST",
    cookie: householdSelection.cookie,
    body: entryBody(`${marker}-other-household`, { requestId: idempotencyKey })
  });
  assert.equal(otherHousehold.response.status, 200, JSON.stringify(otherHousehold.result));
  assert.notEqual(otherHousehold.result.entry.id, firstCreate.result.entry.id, "request IDs must be scoped by household");

  const uploadSession = await request("/photo-upload-sessions", {
    method: "POST", cookie: mainCookie, body: { targetEntryId: null }
  });
  assert.equal(uploadSession.response.status, 200, JSON.stringify(uploadSession.result));
  const photoId = randomUUID();
  const uploadResponse = await fetch(`${origin}/diary/api/photo-upload-sessions/${uploadSession.result.uploadSession.id}/photos`, {
    method: "POST",
    headers: { Cookie: mainCookie, "X-Diary-Request": "1" },
    body: photoForm(photoId)
  });
  assert.equal(uploadResponse.status, 200, await uploadResponse.text());
  const photoRequestId = randomUUID();
  const provisionalBody = entryBody(`${marker}-photo-idempotent`, {
    requestId: photoRequestId,
    content: "写真commit前の仮本文",
    pendingPhotoIds: [photoId],
    photoUploadSessionId: uploadSession.result.uploadSession.id
  });
  const provisional = await request("/entries", { method: "POST", cookie: mainCookie, body: provisionalBody });
  assert.equal(provisional.response.status, 200, JSON.stringify(provisional.result));
  const provisionalReplay = await request("/entries", { method: "POST", cookie: mainCookie, body: provisionalBody });
  assert.equal(provisionalReplay.response.status, 200, JSON.stringify(provisionalReplay.result));
  assert.equal(provisionalReplay.result.entry.id, provisional.result.entry.id);
  const committed = await request(`/photo-upload-sessions/${uploadSession.result.uploadSession.id}/commit`, {
    method: "POST", cookie: mainCookie, body: { entryId: provisional.result.entry.id, photoIds: [photoId] }
  });
  assert.equal(committed.response.status, 200, JSON.stringify(committed.result));
  assert.equal(Number(query(`SELECT COUNT(*) AS count FROM diary_entries WHERE client_request_id = '${photoRequestId}'`)[0].count), 1);
  assert.equal(Number(query(`SELECT COUNT(*) AS count FROM diary_photos WHERE id = '${photoId}' AND entry_id = ${provisional.result.entry.id}`)[0].count), 1);

  const failedCreateBody = entryBody(`${marker}-failed-create`, { tags: ["must-rollback"] });
  const failedCreate = await request("/entries", {
    method: "POST", cookie: mainCookie, body: failedCreateBody, atomicFailure: "create"
  });
  assert.equal(failedCreate.response.status, 500);
  assert.equal(Number(query(`SELECT COUNT(*) AS count FROM diary_entries WHERE title = '${failedCreateBody.title}'`)[0].count), 0);
  assert.equal(Number(query("SELECT COUNT(*) AS count FROM diary_tags WHERE tag = 'must-rollback'")[0].count), 0);

  const updateBaseBody = entryBody(`${marker}-update-base`, { tags: ["before-update"] });
  const updateBase = await request("/entries", { method: "POST", cookie: mainCookie, body: updateBaseBody });
  const failedUpdate = await request(`/entries/${updateBase.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    atomicFailure: "update",
    body: { ...updateBaseBody, requestId: undefined, revision: updateBase.result.entry.revision, title: `${marker}-update-after`, tags: ["after-update"] }
  });
  assert.equal(failedUpdate.response.status, 500);
  const updateAfterFailure = await request(`/entries/${updateBase.result.entry.id}`, { cookie: mainCookie });
  assert.equal(updateAfterFailure.result.entry.title, updateBaseBody.title);
  assert.deepEqual(updateAfterFailure.result.entry.tags, ["before-update"]);
  assert.equal(updateAfterFailure.result.entry.revision, updateBase.result.entry.revision);

  const draftSourceBody = entryBody(`${marker}-draft-source`, { tags: ["source-tag"] });
  const draftSource = await request("/entries", { method: "POST", cookie: mainCookie, body: draftSourceBody });
  const failedDraftCreate = await request(`/entries/${draftSource.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    atomicFailure: "draft-create",
    body: { ...draftSourceBody, requestId: undefined, status: "draft", title: `${marker}-draft-failed`, revision: draftSource.result.entry.revision, tags: ["draft-failed-tag"] }
  });
  assert.equal(failedDraftCreate.response.status, 500);
  assert.equal(Number(query(`SELECT COUNT(*) AS count FROM diary_entries WHERE draft_of_entry_id = ${draftSource.result.entry.id}`)[0].count), 0);
  assert.equal((await request(`/entries/${draftSource.result.entry.id}`, { cookie: mainCookie })).result.entry.title, draftSourceBody.title);

  const draftCreated = await request(`/entries/${draftSource.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    body: { ...draftSourceBody, requestId: undefined, status: "draft", title: `${marker}-draft`, revision: draftSource.result.entry.revision, tags: ["draft-before"] }
  });
  assert.equal(draftCreated.response.status, 200, JSON.stringify(draftCreated.result));
  const failedExistingEditDraftSave = await request(`/entries/${draftSource.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    atomicFailure: "draft-save",
    body: { ...draftSourceBody, requestId: undefined, status: "draft", title: `${marker}-draft-replaced`, revision: draftSource.result.entry.revision, tags: ["draft-replaced"] }
  });
  assert.equal(failedExistingEditDraftSave.response.status, 500);
  const editDraftAfterAtomicFailure = await request(`/entries/${draftCreated.result.entry.id}`, { cookie: mainCookie });
  assert.equal(editDraftAfterAtomicFailure.result.entry.title, `${marker}-draft`);
  assert.deepEqual(editDraftAfterAtomicFailure.result.entry.tags, ["draft-before"]);
  const failedDraftSave = await request(`/entries/${draftCreated.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    atomicFailure: "update",
    body: { entryDate: "2026-08-25", title: `${marker}-draft-after`, content: "draft after", tags: ["draft-after"], status: "draft", revision: draftCreated.result.entry.revision }
  });
  assert.equal(failedDraftSave.response.status, 500);
  const draftAfterSaveFailure = await request(`/entries/${draftCreated.result.entry.id}`, { cookie: mainCookie });
  assert.equal(draftAfterSaveFailure.result.entry.title, `${marker}-draft`);
  assert.deepEqual(draftAfterSaveFailure.result.entry.tags, ["draft-before"]);

  const draftPhotoId = randomUUID();
  const directPhotoUpload = await fetch(`${origin}/diary/api/entries/${draftCreated.result.entry.id}/photos`, {
    method: "POST",
    headers: { Cookie: mainCookie, "X-Diary-Request": "1" },
    body: photoForm(draftPhotoId)
  });
  assert.equal(directPhotoUpload.status, 200, await directPhotoUpload.text());
  const failedPublish = await request(`/entries/${draftCreated.result.entry.id}`, {
    method: "PUT",
    cookie: mainCookie,
    atomicFailure: "draft-publish",
    body: {
      entryDate: "2026-08-25", title: `${marker}-published-after`, content: `published [[写真:${draftPhotoId}]]`,
      tags: ["published-after"], status: "published", revision: draftCreated.result.entry.revision
    }
  });
  assert.equal(failedPublish.response.status, 500);
  const sourceAfterPublishFailure = await request(`/entries/${draftSource.result.entry.id}`, { cookie: mainCookie });
  const draftAfterPublishFailure = await request(`/entries/${draftCreated.result.entry.id}`, { cookie: mainCookie });
  assert.equal(sourceAfterPublishFailure.result.entry.title, draftSourceBody.title);
  assert.equal(draftAfterPublishFailure.result.entry.status, "draft");
  assert.equal(Number(query(`SELECT entry_id FROM diary_photos WHERE id = '${draftPhotoId}'`)[0].entry_id), draftCreated.result.entry.id);

  const chunkedBody = JSON.stringify(entryBody(`${marker}-chunked`, { requestId: randomUUID() }));
  const chunked = await rawJsonRequest("/entries", {
    cookie: mainCookie,
    bodyChunks: [chunkedBody.slice(0, 17), chunkedBody.slice(17)]
  });
  assert.equal(chunked.status, 200, chunked.body);

  const oversized = await rawJsonRequest("/entries", {
    cookie: mainCookie,
    bodyChunks: [JSON.stringify({ requestId: randomUUID(), entryDate: "2026-08-25", title: "large", content: "x".repeat(1_500_001), tags: [] })]
  });
  assert.equal(oversized.status, 413, oversized.body);

  process.stdout.write("Diary idempotency, atomic write, and streamed-size integration tests passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
