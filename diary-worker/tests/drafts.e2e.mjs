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
  ["d1", "execute", "diary-db", "--local", "--command", `UPDATE diary_accounts SET password_hash = '${testHash("chiharu-test")}', must_change_password = 0 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'draft-test-%';`]
]) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", "SESSION_SECRET:diary-draft-test-session-secret"
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
  const rollBeforePost = await request(`/photos?q=${encodeURIComponent(marker)}`, { cookie: mainCookie });
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
  assert.equal((await request(`/photos?q=${encodeURIComponent(marker)}`, { cookie: mainCookie })).result.photos.some((photo) => photo.id === photoId), true);
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

  process.stdout.write("Diary draft lifecycle and isolation integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
