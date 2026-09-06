import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const port = 8806;
const origin = `http://127.0.0.1:${port}`;
const temporaryPassword = "Temp!Household2026";

function testHash(password) {
  return `sha256$${createHash("sha256").update(password).digest("base64url")}`;
}

for (const args of [
  ["d1", "migrations", "apply", "diary-db", "--local"],
  ["d1", "execute", "diary-db", "--local", "--command", "UPDATE diary_accounts SET password_hash = NULL, must_change_password = 1, session_version = 1 WHERE id = 'chiharu-admin'; DELETE FROM diary_entries WHERE title LIKE 'search-test-%';"]
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
  const moduleResponse = await fetch(`${origin}/diary/diary-search.js?v=search-test`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get("content-type"), /javascript/);
  assert.match(await moduleResponse.text(), /export function splitSearchTerms/);
  const main = await login("main@example.test", "main-test");
  const chiharu = await login("giantz3031@gmail.com", temporaryPassword);
  const changed = await request("/password/initial", {
    method: "POST", cookie: chiharu.cookie,
    body: { password: "ちはるの日記", confirmation: "ちはるの日記" }
  });
  assert.equal(changed.response.status, 200);
  const prefix = "search-test-" + randomUUID().slice(0, 12);
  async function create(title, content, cookie = main.cookie, extra = {}) {
    const result = await request("/entries", { method: "POST", cookie,
      body: { entryDate: "2026-08-12", title: prefix + title, content, tags: [prefix], ...extra } });
    assert.equal(result.response.status, 200, JSON.stringify(result.result));
    return result.result.entry.id;
  }
  async function search(q, extra = {}, cookie = main.cookie) {
    const params = new URLSearchParams({ tag: prefix, q, limit: "20", offset: "0", ...extra });
    const result = await request("/entries?" + params, { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.result));
    return result.result;
  }
  const scattered = await create("ふゆ", "公園でお弁当を食べました。");
  const reversed = await create("公園", "お弁当のあとでふゆと遊んだ。");
  const two = await create("ふゆと公園", "散歩した。");
  const one = await create("ふゆ", "家で過ごした。");
  const titleOnly = await create("ふゆと公園とお弁当", "本文だけ。");
  const special = await create("特殊", "<b> 100%_ A+B 😀 👨‍👩‍👧‍👦 O'Reilly & abc ABC");
  await create("ふゆ公園お弁当", "別世帯の日記", changed.cookie);
  const ids = async (q) => (await search(q)).entries.map((entry) => entry.id).sort((a, b) => a - b);
  assert.deepEqual(await ids("ふゆ"), [scattered, reversed, two, one, titleOnly]);
  for (const q of ["ふゆ 公園", "ふゆ　公園", " ふゆ　  公園  ふゆ ", "公園 ふゆ"]) {
    assert.deepEqual(await ids(q), [scattered, reversed, two, titleOnly]);
  }
  assert.deepEqual(await ids("ふゆ 公園 お弁当"), [scattered, reversed, titleOnly]);
  assert.deepEqual(await ids("公"), [scattered, reversed, two, titleOnly]);
  assert.deepEqual(await ids("不存在 公園"), []);
  assert.deepEqual(await ids("<b> %_ A+B 😀 O'Reilly &"), [special]);
  assert.deepEqual(await ids("Abc"), []);
  assert.equal((await search(" 　 ")).entries.length, 6);
  assert.deepEqual((await search("ふゆ 公園", { dateFrom: "2026-08-13" })).entries, []);
  assert.equal((await search("ふゆ 公園", { dateFrom: "2026-08-12", dateTo: "2026-08-12" })).entries.length, 4);
  assert.equal((await search("ふゆ 公園", {}, changed.cookie)).entries.length, 1);
  const manyWords = Array.from({ length: 50 }, (_, index) => String.fromCharCode(0x4e00 + index));
  const manyWordsId = await create("50語", manyWords.join(""));
  assert.deepEqual(await ids(manyWords.join(" ")), [manyWordsId]);
  for (let index = 0; index < 43; index += 1) await create("多数", "公園 公園 ふゆ ふゆ お弁当".repeat(20));
  const pages = [];
  for (const offset of [0, 20, 40]) pages.push(await search("ふゆ 公園 お弁当", { offset: String(offset), limit: "20" }));
  assert.deepEqual(pages.map((page) => page.entries.length), [20, 20, 6]);
  assert.deepEqual(pages.map((page) => page.hasMore), [true, true, false]);
  const all = pages.flatMap((page) => page.entries);
  assert.equal(new Set(all.map((entry) => entry.id)).size, 46);
  assert.ok(all.every((entry, index) => !index || all[index - 1].id > entry.id));
  console.log("Diary real D1 AND search: literal terms, spaces, filters, 20-item paging, duplicates and household isolation passed.");
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}
