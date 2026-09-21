import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8814;
const origin = `http://127.0.0.1:${port}`;
const marker = `last-published-test-${randomUUID().slice(0, 8)}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", "DELETE FROM diary_entries WHERE title LIKE 'last-published-test-%';"]
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

async function request(path, { method = "GET", body, cookie } = {}) {
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
  return { response, result, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

function body(title, extra = {}) {
  return {
    entryDate: "2026-09-21",
    title,
    content: `${title} 本文`,
    tags: [marker],
    ...extra
  };
}

function assertUtcTimestamp(value, message) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, message);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

try {
  await waitForServer();
  const login = await request("/login", { method: "POST", body: { loginId: "main@example.test", password: "main-test" } });
  assert.equal(login.response.status, 200, JSON.stringify(login.result));
  const cookie = login.cookie;

  const requestId = randomUUID();
  const legacyBody = body(`${marker}-legacy`, { entryTime: "09:05", requestId });
  const created = await request("/entries", { method: "POST", cookie, body: legacyBody });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  assertUtcTimestamp(created.result.entry.lastPublishedAt, "new publication uses an explicit UTC timestamp");
  assert.equal("entryTime" in created.result.entry, false, "legacy entryTime is not a diary response field");

  const replay = await request("/entries", {
    method: "POST", cookie, body: { ...legacyBody, entryTime: "23:59" }
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.result));
  assert.equal(replay.result.entry.id, created.result.entry.id, "entryTime is excluded from idempotency");
  assert.equal(replay.result.entry.lastPublishedAt, created.result.entry.lastPublishedAt, "a retry does not republish");

  await pause();
  const republished = await request(`/entries/${created.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-republished`, {
      entryDate: "2026-09-20",
      entryTime: { ignored: true },
      revision: created.result.entry.revision
    })
  });
  assert.equal(republished.response.status, 200, JSON.stringify(republished.result));
  assert.equal(republished.result.entry.entryDate, "2026-09-20", "diary date remains editable");
  assert.ok(republished.result.entry.lastPublishedAt > created.result.entry.lastPublishedAt, "republishing advances publication time");

  const draft = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-draft`, { status: "draft", entryTime: "07:45" })
  });
  assert.equal(draft.response.status, 200, JSON.stringify(draft.result));
  assert.equal(draft.result.entry.lastPublishedAt, null, "draft creation has no publication time");
  await pause();
  const savedDraft = await request(`/entries/${draft.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-draft-saved`, { status: "draft", revision: draft.result.entry.revision })
  });
  assert.equal(savedDraft.result.entry.lastPublishedAt, null, "draft save does not publish");
  const publishedDraft = await request(`/entries/${draft.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-draft-published`, { status: "published", revision: savedDraft.result.entry.revision })
  });
  assertUtcTimestamp(publishedDraft.result.entry.lastPublishedAt, "publishing a standalone draft sets publication time");

  const source = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-source`, { entryDate: "2026-09-19" })
  });
  await pause();
  const editDraft = await request(`/entries/${source.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-edit-draft`, { entryDate: "2026-09-18", status: "draft", revision: source.result.entry.revision })
  });
  assert.equal(editDraft.result.entry.lastPublishedAt, null, "edit draft itself is not published");
  const unchangedSource = await request(`/entries/${source.result.entry.id}`, { cookie });
  assert.equal(unchangedSource.result.entry.lastPublishedAt, source.result.entry.lastPublishedAt, "saving an edit draft preserves source publication time");
  await pause();
  const publishedEdit = await request(`/entries/${editDraft.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-edit-published`, { entryDate: "2026-09-18", status: "published", revision: editDraft.result.entry.revision })
  });
  assert.equal(publishedEdit.result.entry.id, source.result.entry.id);
  assert.ok(publishedEdit.result.entry.lastPublishedAt > source.result.entry.lastPublishedAt, "publishing an edit draft republishes the source");

  const beforeTrash = publishedEdit.result.entry.lastPublishedAt;
  const trashed = await request(`/entries/${publishedEdit.result.entry.id}`, {
    method: "DELETE", cookie, body: { revision: publishedEdit.result.entry.revision }
  });
  assert.equal(trashed.response.status, 200, JSON.stringify(trashed.result));
  const inTrash = await request(`/entries/${publishedEdit.result.entry.id}`, { cookie });
  assert.equal(inTrash.result.entry.lastPublishedAt, beforeTrash, "moving to trash preserves publication time");
  await pause();
  const restored = await request(`/entries/${publishedEdit.result.entry.id}/restore`, { method: "POST", cookie });
  assert.ok(restored.result.entry.lastPublishedAt > beforeTrash, "restore is treated as the latest publication");

  const currentDate = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-current-date`, { entryDate: "2026-09-21" })
  });
  await pause();
  const olderDate = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-older-date`, { entryDate: "2026-09-20" })
  });
  await pause();
  const olderRepublished = await request(`/entries/${olderDate.result.entry.id}`, {
    method: "PUT", cookie,
    body: body(`${marker}-older-republished`, { entryDate: "2026-09-20", revision: olderDate.result.entry.revision })
  });
  const ordered = await request(`/entries?q=${encodeURIComponent(marker)}&limit=50`, { cookie });
  const orderedIds = ordered.result.entries.map((entry) => entry.id);
  assert.ok(orderedIds.indexOf(currentDate.result.entry.id) < orderedIds.indexOf(olderRepublished.result.entry.id),
    "entry_date remains the primary ordering key after an older entry is republished");
  const sameDayIds = ordered.result.entries.filter((entry) => entry.entryDate === "2026-09-20").map((entry) => entry.id);
  assert.ok(sameDayIds.indexOf(olderRepublished.result.entry.id) < sameDayIds.indexOf(republished.result.entry.id),
    "last_published_at orders entries within the same diary date");

  process.stdout.write("Diary publication timestamp, legacy client, drafts, trash/restore, ordering, idempotency, and editable date tests passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
