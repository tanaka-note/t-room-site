import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = await findAvailablePort();
const origin = `http://127.0.0.1:${port}`;
const temporaryPassword = "Temporary-Main-User-2026";
const replacementPassword = "宏知の日記2026";

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const availablePort = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!availablePort) throw new Error("Could not reserve a local test port.");
  return availablePort;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", `UPDATE diary_accounts SET password_hash = '${testHash(temporaryPassword)}', must_change_password = 1, session_version = 1 WHERE id = 'main-user'; UPDATE diary_accounts SET password_hash = '${testHash("chiharu-test")}', must_change_password = 0, session_version = 1 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'main-user-test-%';`]
]) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], { cwd: projectDirectory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const server = spawn(process.execPath, [wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main-admin@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", `DIARY_CHIHARU_TEMP_PASSWORD_HASH:${testHash("chiharu-test")}`,
  "--var", "DIARY_PASSWORD_PEPPER:diary-main-user-test-pepper",
  "--var", "SESSION_SECRET:diary-main-user-test-session-secret"
], { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (output.includes("Ready on")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
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
  return request("/login", { method: "POST", body: { loginId, password } });
}

try {
  await waitForServer();
  const first = await login("sub@a-tanaka.jp", temporaryPassword);
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.equal(first.result.accountName, "田中宏知");
  assert.equal(first.result.householdId, "tanaka-household");
  assert.equal(first.result.isGlobalOwner, false);
  assert.equal(first.result.role, "user");
  assert.equal(first.result.canManageEntries, true);
  assert.equal(first.result.mustChangePassword, true);
  assert.equal(first.result.canViewTrash, true);
  assert.equal(first.result.canPermanentlyDelete, true);
  assert.equal(first.result.canViewInvestment, true);

  const blockedBeforeChange = await request("/entries", { cookie: first.cookie });
  assert.equal(blockedBeforeChange.response.status, 428);

  const changed = await request("/password/initial", {
    method: "POST", cookie: first.cookie,
    body: { password: replacementPassword, confirmation: replacementPassword }
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.result));
  assert.equal(changed.result.mustChangePassword, false);
  assert.equal(changed.result.canViewTrash, true);

  const loggedIn = await login("sub@a-tanaka.jp", replacementPassword);
  assert.equal(loggedIn.response.status, 200, JSON.stringify(loggedIn.result));
  const cookie = loggedIn.cookie;

  const households = await request("/households", { cookie });
  assert.equal(households.response.status, 200);
  assert.deepEqual(households.result.households.map((item) => item.id), ["tanaka-household"]);
  const forbiddenSwitch = await request("/households/select", {
    method: "POST", cookie, body: { householdId: "chiharu-household" }
  });
  assert.equal(forbiddenSwitch.response.status, 403);

  const personalTrash = await request("/entries?trash=1", { cookie });
  assert.equal(personalTrash.response.status, 200);
  const missingPermanent = await request("/entries/1/permanent", {
    method: "DELETE", cookie, body: { revision: 1 }
  });
  assert.equal(missingPermanent.response.status, 404);

  const investment = await request("/investment-history", { cookie });
  assert.equal(investment.response.status, 200);

  const title = `main-user-test-${randomUUID()}`;
  const created = await request("/entries", {
    method: "POST", cookie,
    body: { entryDate: "2026-08-12", title, content: "一般ユーザー投稿", tags: ["一般ユーザー"] }
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.result));
  assert.equal(created.result.entry.authorName, "田中宏知");
  assert.equal(created.result.entry.householdId, undefined);

  const visible = await request(`/entries?q=${encodeURIComponent(title)}`, { cookie });
  assert.equal(visible.response.status, 200);
  assert.ok(visible.result.entries.some((entry) => entry.id === created.result.entry.id));

  const deletedByUser = await request(`/entries/${created.result.entry.id}`, {
    method: "DELETE", cookie, body: { revision: created.result.entry.revision }
  });
  assert.equal(deletedByUser.response.status, 200);
  const visibleInPersonalTrash = await request(`/entries/${created.result.entry.id}`, { cookie });
  assert.equal(visibleInPersonalTrash.response.status, 200);
  const personalTrashAfterDelete = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie });
  assert.ok(personalTrashAfterDelete.result.entries.some((entry) => entry.id === created.result.entry.id));

  const mainAdmin = await login("main-admin@example.test", "main-test");
  assert.equal(mainAdmin.response.status, 200, JSON.stringify(mainAdmin.result));
  assert.equal(mainAdmin.result.role, "admin");
  assert.equal(mainAdmin.result.isGlobalOwner, true);
  const adminTrash = await request(`/entries?trash=1&q=${encodeURIComponent(title)}`, { cookie: mainAdmin.cookie });
  assert.ok(adminTrash.result.entries.some((entry) => entry.id === created.result.entry.id));

  const removePersonalScope = await request(`/entries/${created.result.entry.id}/permanent`, {
    method: "DELETE", cookie,
    body: { revision: visibleInPersonalTrash.result.entry.revision }
  });
  assert.equal(removePersonalScope.response.status, 200, JSON.stringify(removePersonalScope.result));
  assert.equal(removePersonalScope.result.physicallyDeleted, false);
  const goneFromPersonalTrash = await request(`/entries/${created.result.entry.id}`, { cookie });
  assert.equal(goneFromPersonalTrash.response.status, 404);
  const retainedForAdmin = await request(`/entries/${created.result.entry.id}`, { cookie: mainAdmin.cookie });
  assert.equal(retainedForAdmin.response.status, 200);
  assert.equal(retainedForAdmin.result.entry.title, title);
  assert.deepEqual(retainedForAdmin.result.entry.tags, ["一般ユーザー"]);

  const removeAdminRetention = await request(`/entries/${created.result.entry.id}/permanent`, {
    method: "DELETE", cookie: mainAdmin.cookie,
    body: { revision: retainedForAdmin.result.entry.revision }
  });
  assert.equal(removeAdminRetention.response.status, 200, JSON.stringify(removeAdminRetention.result));
  assert.equal(removeAdminRetention.result.physicallyDeleted, true);
  const physicallyGone = await request(`/entries/${created.result.entry.id}`, { cookie: mainAdmin.cookie });
  assert.equal(physicallyGone.response.status, 404);

  const chiharu = await login("giantz3031@gmail.com", "chiharu-test");
  assert.equal(chiharu.response.status, 200);
  const chiharuTitle = `main-user-test-chiharu-${randomUUID()}`;
  const chiharuEntry = await request("/entries", {
    method: "POST", cookie: chiharu.cookie,
    body: { entryDate: "2026-08-12", title: chiharuTitle, content: "千晴世帯限定", tags: ["千晴世帯限定"] }
  });
  assert.equal(chiharuEntry.response.status, 200, JSON.stringify(chiharuEntry.result));
  const direct = await request(`/entries/${chiharuEntry.result.entry.id}`, { cookie });
  assert.equal(direct.response.status, 404);
  const searchLeak = await request(`/entries?q=${encodeURIComponent(chiharuTitle)}`, { cookie });
  assert.equal(searchLeak.response.status, 200);
  assert.equal(searchLeak.result.entries.length, 0);

  process.stdout.write("Diary main user permissions and initial password test passed.\n");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
