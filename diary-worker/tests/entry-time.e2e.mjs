import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8814;
const origin = `http://127.0.0.1:${port}`;
const marker = `entry-time-test-${randomUUID().slice(0, 8)}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", `DELETE FROM diary_entries WHERE title LIKE 'entry-time-test-%';`]
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

try {
  await waitForServer();
  const login = await request("/login", { method: "POST", body: { loginId: "main@example.test", password: "main-test" } });
  assert.equal(login.response.status, 200, JSON.stringify(login.result));
  const cookie = login.cookie;

  const legacy = await request("/entries", { method: "POST", cookie, body: body(`${marker}-legacy`) });
  assert.equal(legacy.response.status, 200, JSON.stringify(legacy.result));
  assert.equal(legacy.result.entry.entryTime, null, "an old client create remains valid and stores NULL");

  const morning = await request("/entries", { method: "POST", cookie, body: body(`${marker}-morning`, { entryTime: "09:05" }) });
  const evening = await request("/entries", { method: "POST", cookie, body: body(`${marker}-evening`, { entryTime: "18:30" }) });
  const eveningLaterId = await request("/entries", { method: "POST", cookie, body: body(`${marker}-evening-later-id`, { entryTime: "18:30" }) });
  for (const created of [morning, evening, eveningLaterId]) assert.equal(created.response.status, 200, JSON.stringify(created.result));

  const ordered = await request(`/entries?q=${encodeURIComponent(marker)}&limit=20`, { cookie });
  assert.deepEqual(ordered.result.entries.slice(0, 4).map((entry) => entry.id), [
    eveningLaterId.result.entry.id,
    evening.result.entry.id,
    morning.result.entry.id,
    legacy.result.entry.id
  ], "published entries sort by date, time, then id; NULL times follow timed entries");

  const idempotencyKey = randomUUID();
  const idempotentBody = body(`${marker}-idempotent`, { entryTime: "05:47", requestId: idempotencyKey });
  const firstCreate = await request("/entries", { method: "POST", cookie, body: idempotentBody });
  const replayCreate = await request("/entries", { method: "POST", cookie, body: idempotentBody });
  assert.equal(replayCreate.response.status, 200, JSON.stringify(replayCreate.result));
  assert.equal(replayCreate.result.entry.id, firstCreate.result.entry.id);
  assert.equal(replayCreate.result.entry.entryTime, "05:47");
  const changedTimeReplay = await request("/entries", {
    method: "POST", cookie, body: { ...idempotentBody, entryTime: "05:48" }
  });
  assert.equal(changedTimeReplay.response.status, 409, "entryTime participates in the idempotent request hash");

  for (const entryTime of ["1:35", "24:00", "12:60", "12:34:56", "nope", 123]) {
    const invalid = await request("/entries", { method: "POST", cookie, body: body(`${marker}-invalid-${String(entryTime)}`, { entryTime }) });
    assert.equal(invalid.response.status, 400, `invalid time must be rejected: ${String(entryTime)}`);
  }

  const fetchedMorning = await request(`/entries/${morning.result.entry.id}`, { cookie });
  assert.equal(fetchedMorning.result.entry.entryTime, "09:05", "detail serialization preserves time");
  const oldClientEdit = await request(`/entries/${morning.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-morning-old-client`), revision: fetchedMorning.result.entry.revision }
  });
  assert.equal(oldClientEdit.response.status, 200, JSON.stringify(oldClientEdit.result));
  assert.equal(oldClientEdit.result.entry.entryTime, "09:05", "an old client update preserves stored time");
  const changedTime = await request(`/entries/${morning.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-morning-changed`), entryTime: "10:15", revision: oldClientEdit.result.entry.revision }
  });
  assert.equal(changedTime.result.entry.entryTime, "10:15");
  const staleUpdate = await request(`/entries/${morning.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-stale`), entryTime: "11:11", revision: oldClientEdit.result.entry.revision }
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal((await request(`/entries/${morning.result.entry.id}`, { cookie })).result.entry.entryTime, "10:15");

  const draft = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-draft`, { entryTime: "07:45", status: "draft" })
  });
  const savedDraft = await request(`/entries/${draft.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-draft-saved`), status: "draft", revision: draft.result.entry.revision }
  });
  assert.equal(savedDraft.result.entry.entryTime, "07:45", "draft save preserves omitted time");
  const publishedDraft = await request(`/entries/${draft.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-draft-published`), status: "published", revision: savedDraft.result.entry.revision }
  });
  assert.equal(publishedDraft.result.entry.entryTime, "07:45", "draft publish preserves time");

  const publishedSource = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-published-source`, { entryTime: "11:22" })
  });
  const editDraft = await request(`/entries/${publishedSource.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-edit-draft`), entryTime: "12:34", status: "draft", revision: publishedSource.result.entry.revision }
  });
  assert.equal(editDraft.result.entry.entryTime, "12:34");
  const editPublished = await request(`/entries/${editDraft.result.entry.id}`, {
    method: "PUT", cookie,
    body: { ...body(`${marker}-edit-published`), status: "published", revision: editDraft.result.entry.revision }
  });
  assert.equal(editPublished.result.entry.id, publishedSource.result.entry.id);
  assert.equal(editPublished.result.entry.entryTime, "12:34", "published edit draft carries its time back to the source");

  const otherDate = await request("/entries", {
    method: "POST", cookie, body: body(`${marker}-other-date`, { entryDate: "2026-08-31", entryTime: "23:59" })
  });
  assert.equal(otherDate.response.status, 200);
  const exactDate = await request(`/entries?q=${encodeURIComponent(marker)}&dateFrom=2026-09-21&dateTo=2026-09-21&limit=50`, { cookie });
  assert.ok(exactDate.result.entries.length >= 7);
  assert.ok(exactDate.result.entries.every((entry) => entry.entryDate === "2026-09-21"));
  const month = await request(`/entries?q=${encodeURIComponent(marker)}&month=2026-08&limit=50`, { cookie });
  assert.deepEqual(month.result.entries.map((entry) => entry.id), [otherDate.result.entry.id], "month filtering remains entry_date based");

  process.stdout.write("Diary entry time create, edit, draft, ordering, validation, idempotency, revision, and date filtering tests passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
