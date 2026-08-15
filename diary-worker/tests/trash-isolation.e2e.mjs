import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8802;
const origin = `http://127.0.0.1:${port}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  [
    "d1", "execute", "diary-db", "--local", "--command",
    `UPDATE diary_accounts SET password_hash = '${testHash("chiharu-test")}', must_change_password = 0 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'trash-scope-test-%';`
  ]
]) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", "SESSION_SECRET:diary-trash-scope-test-session-secret"
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
  return { session: result.result, cookie: result.cookie };
}

async function createEntry(cookie, title) {
  const created = await request("/entries", {
    method: "POST",
    cookie,
    body: { entryDate: "2026-08-15", title, content: "trash scope test", tags: ["trash-scope"] }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  return created.result.entry;
}

async function trashEntry(cookie, entry) {
  const moved = await request(`/entries/${entry.id}`, {
    method: "DELETE",
    cookie,
    body: { revision: entry.revision }
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.result));
}

async function findInTrash(cookie, title) {
  const trash = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie });
  assert.equal(trash.response.status, 200, JSON.stringify(trash.result));
  return trash.result.entries.find((entry) => entry.title === title) || null;
}

try {
  await waitForServer();
  const main = await login("main@example.test", "main-test");
  const wife = await login("wife@example.test", "wife-test");
  const chiharu = await login("giantz3031@gmail.com", "chiharu-test");
  assert.equal(wife.session.canViewTrash, true);
  assert.equal(wife.session.canPermanentlyDelete, true);

  const wifeTitle = `trash-scope-test-wife-${randomUUID()}`;
  const wifeEntry = await createEntry(wife.cookie, wifeTitle);
  await trashEntry(wife.cookie, wifeEntry);
  const wifeCopy = await findInTrash(wife.cookie, wifeTitle);
  const mainCopy = await findInTrash(main.cookie, wifeTitle);
  assert.ok(wifeCopy);
  assert.ok(mainCopy);

  const wifeDelete = await request(`/entries/${wifeEntry.id}/permanent`, {
    method: "DELETE", cookie: wife.cookie, body: { revision: wifeCopy.revision }
  });
  assert.equal(wifeDelete.response.status, 200, JSON.stringify(wifeDelete.result));
  assert.equal(wifeDelete.result.physicallyDeleted, false);
  assert.equal(await findInTrash(wife.cookie, wifeTitle), null);
  assert.ok(await findInTrash(main.cookie, wifeTitle));

  const mainDelete = await request(`/entries/${wifeEntry.id}/permanent`, {
    method: "DELETE", cookie: main.cookie, body: { revision: mainCopy.revision }
  });
  assert.equal(mainDelete.response.status, 200, JSON.stringify(mainDelete.result));
  assert.equal(mainDelete.result.physicallyDeleted, true);
  assert.equal((await request(`/entries/${wifeEntry.id}`, { cookie: main.cookie })).response.status, 404);

  const mainOwnedTitle = `trash-scope-test-main-owned-${randomUUID()}`;
  const mainOwned = await createEntry(main.cookie, mainOwnedTitle);
  await trashEntry(wife.cookie, mainOwned);
  assert.equal(await findInTrash(wife.cookie, mainOwnedTitle), null);
  assert.ok(await findInTrash(main.cookie, mainOwnedTitle));
  const wifeUnauthorized = await request(`/entries/${mainOwned.id}/permanent`, {
    method: "DELETE", cookie: wife.cookie, body: { revision: mainOwned.revision + 1 }
  });
  assert.equal(wifeUnauthorized.response.status, 404);

  const restoreTitle = `trash-scope-test-restore-${randomUUID()}`;
  const restoreEntry = await createEntry(wife.cookie, restoreTitle);
  await trashEntry(wife.cookie, restoreEntry);
  const restored = await request(`/entries/${restoreEntry.id}/restore`, { method: "POST", cookie: main.cookie });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.result));
  assert.equal(restored.result.entry.deletedAt, null);
  assert.equal(await findInTrash(wife.cookie, restoreTitle), null);
  assert.equal(await findInTrash(main.cookie, restoreTitle), null);

  const chiharuTitle = `trash-scope-test-chiharu-${randomUUID()}`;
  const chiharuEntry = await createEntry(chiharu.cookie, chiharuTitle);
  await trashEntry(chiharu.cookie, chiharuEntry);
  assert.ok(await findInTrash(chiharu.cookie, chiharuTitle));
  assert.equal(await findInTrash(main.cookie, chiharuTitle), null);

  const switched = await request("/households/select", {
    method: "POST", cookie: main.cookie, body: { householdId: "chiharu-household" }
  });
  assert.equal(switched.response.status, 200, JSON.stringify(switched.result));
  assert.ok(await findInTrash(switched.cookie, chiharuTitle));

  const chiharuDeleted = await findInTrash(chiharu.cookie, chiharuTitle);
  const chiharuPermanent = await request(`/entries/${chiharuEntry.id}/permanent`, {
    method: "DELETE", cookie: chiharu.cookie, body: { revision: chiharuDeleted.revision }
  });
  assert.equal(chiharuPermanent.response.status, 200, JSON.stringify(chiharuPermanent.result));
  assert.equal(chiharuPermanent.result.physicallyDeleted, true);
  assert.equal(await findInTrash(switched.cookie, chiharuTitle), null);

  const scopeCheck = spawnSync(process.execPath, [
    wranglerPath, "d1", "execute", "diary-db", "--local", "--json", "--command",
    `SELECT COUNT(*) AS count FROM diary_trash_scopes WHERE household_id = 'chiharu-household' AND owner_account_id = 'main-admin' AND entry_id = ${chiharuEntry.id}`
  ], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(scopeCheck.status, 0, scopeCheck.stderr || scopeCheck.stdout);
  const scopeRows = JSON.parse(scopeCheck.stdout);
  assert.equal(Number(scopeRows[0].results[0].count), 0);

  process.stdout.write("Diary trash scope isolation integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
