import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8796;
const origin = `http://127.0.0.1:${port}`;

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

const migration = spawnSync(process.execPath, [wranglerPath, "d1", "migrations", "apply", "diary-db", "--local"], {
  cwd: projectDirectory,
  encoding: "utf8"
});
assert.equal(migration.status, 0, migration.stderr || migration.stdout);

const clearLoginAttempts = spawnSync(process.execPath, [
  wranglerPath,
  "d1",
  "execute",
  "diary-db",
  "--local",
  "--command",
  "DELETE FROM diary_login_attempts"
], {
  cwd: projectDirectory,
  encoding: "utf8"
});
assert.equal(clearLoginAttempts.status, 0, clearLoginAttempts.stderr || clearLoginAttempts.stdout);

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
  "SESSION_SECRET:diary-permission-integration-test-session-secret"
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
  let result = {};
  try { result = await response.json(); } catch {}
  return { response, result };
}

async function login(loginId, password) {
  const { response, result } = await request("/login", { method: "POST", body: { loginId, password } });
  assert.equal(response.status, 200, JSON.stringify(result));
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /Max-Age=2592000/);
  return { session: result, cookie: setCookie.split(";", 1)[0] };
}

try {
  await waitForServer();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wrongId = await request("/login", { method: "POST", body: { loginId: "unknown@example.test", password: "wrong" } });
    assert.equal(wrongId.response.status, 401);
  }

  const wife = await login("wife@example.test", "wife-test");
  assert.equal(wife.session.canViewTrash, true);
  assert.equal(wife.session.canPermanentlyDelete, true);
  const refreshedSession = await request("/session", { cookie: wife.cookie });
  assert.equal(refreshedSession.response.status, 200);
  assert.equal(refreshedSession.result.authenticated, true);
  assert.match(refreshedSession.response.headers.get("set-cookie"), /Max-Age=2592000/);

  const title = `permission-test-${randomUUID()}`;
  const created = await request("/entries", {
    method: "POST",
    cookie: wife.cookie,
    body: {
      entryDate: "2026-08-09",
      title,
      content: "permission integration test",
      contentFormat: {
        version: 1,
        runs: [{ start: 0, end: 10, bold: true, italic: false, underline: true, color: "blue" }]
      },
      tags: []
    }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  const entry = created.result.entry;
  assert.deepEqual(entry.contentFormat, {
    version: 1,
    runs: [{ start: 0, end: 10, bold: true, italic: false, underline: true, color: "blue" }]
  });

  const moved = await request(`/entries/${entry.id}`, {
    method: "DELETE",
    cookie: wife.cookie,
    body: { revision: entry.revision }
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.result));

  const wifeTrash = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie: wife.cookie });
  assert.equal(wifeTrash.response.status, 200);
  assert.ok(wifeTrash.result.entries.some((candidate) => candidate.id === entry.id));

  const main = await login("main@example.test", "main-test");
  assert.equal(main.session.canViewTrash, true);
  assert.equal(main.session.canPermanentlyDelete, true);
  const trash = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie: main.cookie });
  assert.equal(trash.response.status, 200, JSON.stringify(trash.result));
  const deletedEntry = trash.result.entries.find((candidate) => candidate.id === entry.id);
  assert.ok(deletedEntry);
  assert.equal(deletedEntry.deletedByName, "田中暢美");

  const wifePermanent = await request(`/entries/${entry.id}/permanent`, {
    method: "DELETE",
    cookie: wife.cookie,
    body: { revision: deletedEntry.revision }
  });
  assert.equal(wifePermanent.response.status, 200);
  assert.equal(wifePermanent.result.physicallyDeleted, false);
  const wifeTrashAfterDelete = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie: wife.cookie });
  assert.equal(wifeTrashAfterDelete.result.entries.some((candidate) => candidate.id === entry.id), false);

  const mainTrashAfterWifeDelete = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie: main.cookie });
  assert.ok(mainTrashAfterWifeDelete.result.entries.some((candidate) => candidate.id === entry.id));

  const permanentlyDeleted = await request(`/entries/${entry.id}/permanent`, {
    method: "DELETE",
    cookie: main.cookie,
    body: { revision: deletedEntry.revision }
  });
  assert.equal(permanentlyDeleted.response.status, 200, JSON.stringify(permanentlyDeleted.result));
  const missing = await request(`/entries/${entry.id}`, { cookie: main.cookie });
  assert.equal(missing.response.status, 404);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrongPassword = await request("/login", { method: "POST", body: { loginId: "main@example.test", password: "wrong" } });
    assert.equal(wrongPassword.response.status, 401);
  }
  const locked = await request("/login", { method: "POST", body: { loginId: "main@example.test", password: "main-test" } });
  assert.equal(locked.response.status, 429);

  process.stdout.write("Diary permission integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
