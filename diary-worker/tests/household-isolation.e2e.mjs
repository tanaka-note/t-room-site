import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8798;
const origin = `http://127.0.0.1:${port}`;
const temporaryPassword = "Temp!Household2026";

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", "UPDATE diary_accounts SET password_hash = NULL, must_change_password = 1, session_version = 1 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'household-test-%';"]
]) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", `DIARY_CHIHARU_TEMP_PASSWORD_HASH:${testHash(temporaryPassword)}`,
  "--var", "DIARY_PASSWORD_PEPPER:diary-household-test-password-pepper",
  "--var", "SESSION_SECRET:diary-household-test-session-secret"
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
  return { session: result.result, cookie: result.cookie };
}

try {
  await waitForServer();
  const main = await login("main@example.test", "main-test");
  const wife = await login("wife@example.test", "wife-test");
  const chiharuFirst = await login("flw2-0203freedom@ezweb.ne.jp", temporaryPassword);
  assert.equal(chiharuFirst.session.mustChangePassword, true);

  const blockedBeforeChange = await request("/entries", { cookie: chiharuFirst.cookie });
  assert.equal(blockedBeforeChange.response.status, 428);

  const changed = await request("/password/initial", {
    method: "POST", cookie: chiharuFirst.cookie,
    body: { password: "ちはるの日記", confirmation: "ちはるの日記" }
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.result));
  assert.equal(changed.result.mustChangePassword, false);
  await request("/logout", { method: "POST", cookie: changed.cookie });
  const chiharuAfterReset = await login("flw2-0203freedom@ezweb.ne.jp", "ちはるの日記");
  assert.equal(chiharuAfterReset.session.mustChangePassword, false);
  const chiharuCookie = chiharuAfterReset.cookie;

  const title = `household-test-${randomUUID()}`;
  const created = await request("/entries", {
    method: "POST", cookie: chiharuCookie,
    body: { entryDate: "2026-08-12", title, content: "千晴専用", tags: ["千晴専用"] }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  const id = created.result.entry.id;

  const oneDay = await request("/entries?dateFrom=2026-08-12", { cookie: chiharuCookie });
  assert.equal(oneDay.response.status, 200);
  assert.ok(oneDay.result.entries.some((entry) => entry.id === id));
  const thirtyDays = await request("/entries?dateFrom=2026-08-01&dateTo=2026-08-30", { cookie: chiharuCookie });
  assert.equal(thirtyDays.response.status, 200);
  const tooLong = await request("/entries?dateFrom=2026-08-01&dateTo=2026-08-31", { cookie: chiharuCookie });
  assert.equal(tooLong.response.status, 400);

  for (const otherCookie of [main.cookie, wife.cookie]) {
    const direct = await request(`/entries/${id}`, { cookie: otherCookie });
    assert.equal(direct.response.status, 404);
    const list = await request(`/entries?q=${encodeURIComponent(title)}`, { cookie: otherCookie });
    assert.equal(list.result.entries.length, 0);
    const meta = await request("/meta", { cookie: otherCookie });
    assert.equal(meta.result.tags.some((tag) => tag.value === "千晴専用"), false);
  }

  const deniedInvestment = await request("/investment-history", { cookie: chiharuCookie });
  assert.equal(deniedInvestment.response.status, 404);

  const switched = await request("/households/select", {
    method: "POST", cookie: main.cookie, body: { householdId: "chiharu-household" }
  });
  assert.equal(switched.response.status, 200);
  const ownerView = await request(`/entries/${id}`, { cookie: switched.cookie });
  assert.equal(ownerView.response.status, 200);
  assert.equal(ownerView.result.entry.title, title);

  const moved = await request(`/entries/${id}`, {
    method: "DELETE", cookie: chiharuCookie, body: { revision: created.result.entry.revision }
  });
  assert.equal(moved.response.status, 200);
  const trash = await request("/entries?trash=1", { cookie: chiharuCookie });
  const deleted = trash.result.entries.find((entry) => entry.id === id);
  assert.ok(deleted);
  const permanent = await request(`/entries/${id}/permanent`, {
    method: "DELETE", cookie: chiharuCookie, body: { revision: deleted.revision }
  });
  assert.equal(permanent.response.status, 200);

  process.stdout.write("Diary household isolation integration test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
