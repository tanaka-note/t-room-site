import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const migrationDirectory = new URL("../migrations/", import.meta.url);
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8821;
const origin = `http://127.0.0.1:${port}`;
const marker = `tag-order-${randomUUID()}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

function wrangler(...args) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], {
    cwd: projectDirectory,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function verifyMigrationBackfill() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (let number = 1; number <= 16; number += 1) {
    const prefix = String(number).padStart(4, "0");
    const [name] = [
      "0001_init.sql", "0002_entry_authors.sql", "0003_investment_history.sql", "0004_entry_deletion_actor.sql",
      "0005_diary_photos.sql", "0006_login_attempts.sql", "0007_household_isolation.sql", "0008_chiharu_login_reset.sql",
      "0009_main_user.sql", "0010_entry_rich_text.sql", "0011_trash_scopes.sql", "0012_entry_drafts.sql",
      "0013_main_user_trash_and_media_retry.sql", "0014_diary_favorites.sql", "0015_photo_upload_staging.sql",
      "0016_entry_write_integrity.sql"
    ].filter((candidate) => candidate.startsWith(prefix));
    database.exec(await readFile(new URL(name, migrationDirectory), "utf8"));
  }
  database.prepare(`
    INSERT INTO diary_entries (entry_date, title, content, author_id, author_name, household_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("2026-08-26", "migration order", "body", "main-admin", "管理者", "tanaka-household");
  const entryId = Number(database.prepare("SELECT last_insert_rowid() AS id").get().id);
  for (const tag of ["Z", "A", "M", "10", "2", "ふゆ"]) {
    database.prepare("INSERT INTO diary_tags (entry_id, tag) VALUES (?, ?)").run(entryId, tag);
  }
  database.exec(await readFile(new URL("0017_diary_tag_order.sql", migrationDirectory), "utf8"));
  assert.deepEqual(
    database.prepare("SELECT tag, sort_order FROM diary_tags WHERE entry_id = ? ORDER BY sort_order ASC").all(entryId)
      .map((row) => ({ ...row })),
    ["Z", "A", "M", "10", "2", "ふゆ"].map((tag, sort_order) => ({ tag, sort_order })),
    "migration must backfill the prior row order without alphabetizing or dropping tags"
  );
  assert.throws(
    () => database.prepare("INSERT INTO diary_tags (entry_id, tag, sort_order) VALUES (?, ?, ?)").run(entryId, "invalid", -1),
    /CHECK/,
    "stored tag positions must be non-negative"
  );
  database.close();
}

await verifyMigrationBackfill();
wrangler("d1", "migrations", "apply", "diary-db", "--local");
wrangler("d1", "execute", "diary-db", "--local", "--command", "DELETE FROM diary_entries WHERE title LIKE 'tag-order-%';");

const server = spawn(process.execPath, [
  wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", "SESSION_SECRET:diary-tag-order-session-secret"
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

async function login() {
  const result = await request("/login", {
    method: "POST",
    body: { loginId: "main@example.test", password: "main-test" }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  return result.cookie;
}

function entryBody(title, tags, overrides = {}) {
  return {
    requestId: randomUUID(),
    entryDate: "2026-08-26",
    title,
    content: `${title} body`,
    contentFormat: null,
    tags,
    status: "published",
    excludedPhotoIds: [],
    ...overrides
  };
}

function findEntry(result, id) {
  const entry = result.entries?.find((candidate) => candidate.id === id);
  assert.ok(entry, `entry ${id} was not returned: ${JSON.stringify(result)}`);
  return entry;
}

try {
  await waitForServer();
  const cookie = await login();
  const initialOrder = ["Z", "A", "M", "10", "2", "ふゆ"];
  const title = `${marker}-published`;
  const created = await request("/entries", {
    method: "POST",
    cookie,
    body: entryBody(title, initialOrder)
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  assert.deepEqual(created.result.entry.tags, initialOrder, "create response must preserve input order");
  const entryId = created.result.entry.id;

  const detail = await request(`/entries/${entryId}`, { cookie });
  assert.deepEqual(detail.result.entry.tags, initialOrder, "detail must preserve input order");
  const queryList = await request(`/entries?q=${encodeURIComponent(marker)}`, { cookie });
  assert.deepEqual(findEntry(queryList.result, entryId).tags, initialOrder, "search results must preserve input order");
  const monthList = await request("/entries?month=2026-08", { cookie });
  assert.deepEqual(findEntry(monthList.result, entryId).tags, initialOrder, "month results must preserve input order");
  const tagList = await request(`/entries?tag=${encodeURIComponent("2")}`, { cookie });
  assert.deepEqual(findEntry(tagList.result, entryId).tags, initialOrder, "tag-filtered results must preserve input order");

  const favorite = await request(`/entries/${entryId}/favorite`, { method: "POST", cookie });
  assert.equal(favorite.response.status, 200, JSON.stringify(favorite.result));
  const favoriteList = await request("/entries?favorite=1&limit=50", { cookie });
  assert.deepEqual(findEntry(favoriteList.result, entryId).tags, initialOrder, "favorites must preserve input order");

  const reorderedTags = ["ふゆ", "2", "10", "M", "A", "Z"];
  const reordered = await request(`/entries/${entryId}`, {
    method: "PUT",
    cookie,
    body: entryBody(title, reorderedTags, { requestId: undefined, revision: created.result.entry.revision })
  });
  assert.equal(reordered.response.status, 200, JSON.stringify(reordered.result));
  assert.deepEqual(reordered.result.entry.tags, reorderedTags, "editing must persist a new order");

  const tagsAdded = ["ふゆ", "新規", "2", "10", "M", "A", "Z"];
  const added = await request(`/entries/${entryId}`, {
    method: "PUT",
    cookie,
    body: entryBody(title, tagsAdded, { requestId: undefined, revision: reordered.result.entry.revision })
  });
  assert.equal(added.response.status, 200, JSON.stringify(added.result));
  assert.deepEqual(added.result.entry.tags, tagsAdded, "adding a tag must preserve its input position");

  const finalTags = ["新規", "M", "Z"];
  const removed = await request(`/entries/${entryId}`, {
    method: "PUT",
    cookie,
    body: entryBody(title, finalTags, { requestId: undefined, revision: added.result.entry.revision })
  });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.result));
  assert.deepEqual(removed.result.entry.tags, finalTags, "removing tags must preserve the remaining input order");

  const ledger = JSON.parse(wrangler(
    "d1", "execute", "diary-db", "--local", "--json", "--command",
    `SELECT tag, sort_order FROM diary_tags WHERE entry_id = ${entryId} ORDER BY sort_order ASC`
  ))[0].results;
  assert.deepEqual(ledger, finalTags.map((tag, sort_order) => ({ tag, sort_order })), "D1 must store contiguous tag positions");

  const moved = await request(`/entries/${entryId}`, {
    method: "DELETE",
    cookie,
    body: { revision: removed.result.entry.revision }
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.result));
  const trash = await request(`/entries?trash=1&q=${encodeURIComponent(marker)}`, { cookie });
  assert.deepEqual(findEntry(trash.result, entryId).tags, finalTags, "trash results must preserve input order");
  const restored = await request(`/entries/${entryId}/restore`, { method: "POST", cookie });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.result));
  assert.deepEqual(restored.result.entry.tags, finalTags, "restoring from trash must preserve input order");
  assert.deepEqual((await request(`/entries/${entryId}`, { cookie })).result.entry.tags, finalTags, "reload must preserve input order");

  const draftOrder = ["2", "Z", "A", "ふゆ"];
  const draftTitle = `${marker}-draft`;
  const draft = await request("/entries", {
    method: "POST",
    cookie,
    body: entryBody(draftTitle, draftOrder, { status: "draft" })
  });
  assert.equal(draft.response.status, 200, JSON.stringify(draft.result));
  assert.deepEqual(draft.result.entry.tags, draftOrder);
  assert.deepEqual(findEntry((await request("/entries?draft=1", { cookie })).result, draft.result.entry.id).tags, draftOrder,
    "draft list must preserve input order");
  assert.deepEqual((await request(`/entries/${draft.result.entry.id}`, { cookie })).result.entry.tags, draftOrder,
    "draft detail must preserve input order");
  const publishedDraft = await request(`/entries/${draft.result.entry.id}`, {
    method: "PUT",
    cookie,
    body: entryBody(draftTitle, draftOrder, { requestId: undefined, revision: draft.result.entry.revision })
  });
  assert.equal(publishedDraft.response.status, 200, JSON.stringify(publishedDraft.result));
  assert.deepEqual(publishedDraft.result.entry.tags, draftOrder, "publishing a draft must preserve input order");

  process.stdout.write("Diary tag order migration, create/edit/draft/list/detail/filter/favorite/trash/restore integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  wrangler("d1", "execute", "diary-db", "--local", "--command", "DELETE FROM diary_entries WHERE title LIKE 'tag-order-%';");
}
