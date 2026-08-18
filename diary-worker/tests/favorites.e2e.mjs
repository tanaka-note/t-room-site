import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8814;
const origin = `http://127.0.0.1:${port}`;
const marker = randomUUID();

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], {
    cwd: projectDirectory,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function queryLocalDatabase(command) {
  return JSON.parse(runWrangler(["d1", "execute", "diary-db", "--local", "--json", "--command", command]))[0].results;
}

runWrangler(["d1", "migrations", "apply", "diary-db", "--local"]);
runWrangler(["d1", "execute", "diary-db", "--local", "--command", `UPDATE diary_accounts SET password_hash = '${testHash("chiharu-test")}', must_change_password = 0 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'favorite-test-%';`]);

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", "DIARY_CHIHARU_TEMP_PASSWORD_HASH:" + testHash("chiharu-test"),
  "--var", "SESSION_SECRET:diary-favorite-test-session-secret"
], { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${origin}/diary/api/session`)).ok) return;
    } catch {}
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

async function createEntry(cookie, title, options = {}) {
  const result = await request("/entries", {
    method: "POST",
    cookie,
    body: {
      entryDate: options.entryDate || "2026-08-18",
      title,
      content: options.content || title,
      status: options.status || "published",
      tags: []
    }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  return result.result.entry;
}

try {
  await waitForServer();
  const main = await login("main@example.test", "main-test");
  const wife = await login("wife@example.test", "wife-test");
  const chiharu = await login("giantz3031@gmail.com", "chiharu-test");

  const sharedEntry = await createEntry(wife.cookie, `favorite-test-${marker}-shared`);
  const mainBefore = await request(`/entries/${sharedEntry.id}`, { cookie: main.cookie });
  const wifeBefore = await request(`/entries/${sharedEntry.id}`, { cookie: wife.cookie });
  assert.equal(mainBefore.result.entry.isFavorite, false);
  assert.equal(wifeBefore.result.entry.isFavorite, false);

  const registered = await request(`/entries/${sharedEntry.id}/favorite`, { method: "POST", cookie: main.cookie });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.result.isFavorite, true);
  const idempotent = await request(`/entries/${sharedEntry.id}/favorite`, { method: "POST", cookie: main.cookie });
  assert.equal(idempotent.response.status, 200);
  assert.equal(idempotent.result.isFavorite, true);
  assert.equal((await request(`/entries/${sharedEntry.id}`, { cookie: main.cookie })).result.entry.isFavorite, true);
  assert.equal((await request(`/entries/${sharedEntry.id}`, { cookie: wife.cookie })).result.entry.isFavorite, false);
  assert.equal((await request("/entries?favorite=1", { cookie: main.cookie })).result.entries.some((entry) => entry.id === sharedEntry.id), true);
  assert.equal((await request("/entries?favorite=1", { cookie: wife.cookie })).result.entries.some((entry) => entry.id === sharedEntry.id), false);

  const page = await fetch(`${origin}/diary/favorites/`, { headers: { Cookie: main.cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="entry-list"/);

  const draft = await createEntry(main.cookie, `favorite-test-${marker}-draft`, { status: "draft", content: "" });
  const draftFavorite = await request(`/entries/${draft.id}/favorite`, { method: "POST", cookie: main.cookie });
  assert.equal(draftFavorite.response.status, 404);
  assert.equal((await request("/entries?favorite=1", { cookie: main.cookie })).result.entries.some((entry) => entry.id === draft.id), false);

  const moved = await request(`/entries/${sharedEntry.id}`, {
    method: "DELETE", cookie: main.cookie, body: { revision: sharedEntry.revision }
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.result));
  assert.equal((await request("/entries?favorite=1", { cookie: main.cookie })).result.entries.some((entry) => entry.id === sharedEntry.id), false);
  const trashEntry = (await request(`/entries?trash=1&q=${encodeURIComponent(sharedEntry.title)}`, { cookie: main.cookie })).result.entries.find((entry) => entry.id === sharedEntry.id);
  assert.ok(trashEntry);
  assert.equal(trashEntry.isFavorite, true);

  const restored = await request(`/entries/${sharedEntry.id}/restore`, { method: "POST", cookie: main.cookie });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.result));
  assert.equal(restored.result.entry.isFavorite, true);
  assert.equal((await request("/entries?favorite=1", { cookie: main.cookie })).result.entries.some((entry) => entry.id === sharedEntry.id), true);

  const movedAgain = await request(`/entries/${sharedEntry.id}`, {
    method: "DELETE", cookie: main.cookie, body: { revision: restored.result.entry.revision }
  });
  assert.equal(movedAgain.response.status, 200);
  const trashAgain = (await request(`/entries?trash=1&q=${encodeURIComponent(sharedEntry.title)}`, { cookie: main.cookie })).result.entries.find((entry) => entry.id === sharedEntry.id);
  const permanentlyDeleted = await request(`/entries/${sharedEntry.id}/permanent`, {
    method: "DELETE", cookie: main.cookie, body: { revision: trashAgain.revision }
  });
  assert.equal(permanentlyDeleted.response.status, 200, JSON.stringify(permanentlyDeleted.result));
  assert.deepEqual(queryLocalDatabase(`SELECT COUNT(*) AS count FROM diary_favorites WHERE entry_id = ${sharedEntry.id}`), [{ count: 0 }]);

  const otherHouseholdEntry = await createEntry(chiharu.cookie, `favorite-test-${marker}-chiharu`, { entryDate: "2026-08-17" });
  const blockedCrossHousehold = await request(`/entries/${otherHouseholdEntry.id}/favorite`, { method: "POST", cookie: main.cookie });
  assert.equal(blockedCrossHousehold.response.status, 404);
  const switched = await request("/households/select", {
    method: "POST", cookie: main.cookie, body: { householdId: "chiharu-household" }
  });
  assert.equal(switched.response.status, 200);
  const switchedFavorite = await request(`/entries/${otherHouseholdEntry.id}/favorite`, { method: "POST", cookie: switched.cookie });
  assert.equal(switchedFavorite.response.status, 200);
  assert.equal(switchedFavorite.result.isFavorite, true);
  assert.equal((await request(`/entries/${otherHouseholdEntry.id}`, { cookie: chiharu.cookie })).result.entry.isFavorite, false);

  process.stdout.write("Diary favorite account isolation, filtering, trash/restore, permanent delete, and route integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
