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
const port = 8822;
const origin = `http://127.0.0.1:${port}`;
const marker = `weather-${randomUUID()}`;

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

wrangler("d1", "migrations", "apply", "diary-db", "--local");
wrangler("d1", "execute", "diary-db", "--local", "--command", "DELETE FROM diary_entries WHERE title LIKE 'weather-%';");

const server = spawn(process.execPath, [
  wranglerPath, "dev", "--local", "--port", String(port),
  "--var", "DIARY_MAIN_ADMIN_LOGIN_ID:main@example.test",
  "--var", "DIARY_WIFE_ADMIN_LOGIN_ID:wife@example.test",
  "--var", `DIARY_MAIN_ADMIN_PASSWORD_HASH:${testHash("main-test")}`,
  "--var", `DIARY_WIFE_ADMIN_PASSWORD_HASH:${testHash("wife-test")}`,
  "--var", "SESSION_SECRET:diary-weather-session-secret"
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
  const create = async (weather, extra = {}) => {
    const body = entryBody(marker, [], { ...(weather === undefined ? {} : { weather }), ...extra });
    const result = await request('/entries', { method: 'POST', cookie, body });
    assert.equal(result.response.status, 200, JSON.stringify(result.result));
    return { entry: result.result.entry, body };
  };
  const update = async (entry, extra = {}) => {
    const result = await request('/entries/' + entry.id, { method: 'PUT', cookie,
      body: entryBody(marker, [], { revision: entry.revision, requestId: undefined, ...extra }) });
    assert.equal(result.response.status, 200, JSON.stringify(result.result));
    return result.result.entry;
  };
  let {entry: old} = await create(undefined);
  assert.equal(old.weather, null);
  for (const weather of ['sunny','cloudy','partly_cloudy','cloudy_rain','rain','heavy_rain','thunder','snow']) {
    const { entry, body } = await create(weather);
    assert.equal(entry.weather, weather);
    assert.equal((await request('/entries/' + entry.id, { cookie })).result.entry.weather, weather);
    const replay = await request('/entries', { method: 'POST', cookie, body });
    assert.equal(replay.result.entry.id, entry.id);
    const conflict = await request('/entries', { method: 'POST', cookie, body: {...body, weather:null} });
    assert.equal(conflict.response.status, 409);
  }
  old = await update(old, {weather:'sunny'});
  old = await update(old, {title:marker+' title edit',content:'Changed body'});
  assert.equal(old.weather,'sunny','old client omitting weather retains it');
  old = await update(old, {weather:'rain'});
  assert.equal(old.weather,'rain');
  let draft = await update(old, {status:'draft',weather:'snow'});
  assert.equal(draft.weather,'snow');
  assert.equal((await request('/entries/'+old.id,{cookie})).result.entry.weather,'rain');
  draft = await update(draft,{status:'draft',weather:'thunder'});
  assert.equal(draft.weather,'thunder');
  old = await update(draft,{status:'published'});
  assert.equal(old.weather,'thunder','publishing edit draft retains weather');
  const deletion = await request('/entries/'+old.id,{method:'DELETE',cookie,body:{revision:old.revision}});
  assert.equal(deletion.response.status,200);
  const restored = await request('/entries/'+old.id+'/restore',{method:'POST',cookie});
  assert.equal(restored.result.entry.weather,'thunder');
  old = await update(restored.result.entry,{weather:null});
  assert.equal(old.weather,null);
  for (const weather of ['bad','',1,{},'☀']) {
    const invalid = await request('/entries',{method:'POST',cookie,body:entryBody(marker,[],{weather})});
    assert.equal(invalid.response.status,400);
    const edit = await request('/entries/'+old.id,{method:'PUT',cookie,body:entryBody(marker,[],{weather,revision:old.revision})});
    assert.equal(edit.response.status,400);
  }
  const search = await request('/entries?limit=50&q='+encodeURIComponent(marker),{cookie});
  assert.ok(search.result.entries.some(entry=>entry.weather==='sunny'), JSON.stringify(search.result));
  const ownId=old.id;
  const wife=await request('/login',{method:'POST',body:{loginId:'wife@example.test',password:'wife-test'}});
  assert.equal((await request('/entries/'+ownId,{cookie:wife.cookie})).response.status,200, 'existing same-household sharing is preserved');
  console.log('Weather API: all IDs, null, omitted fields, draft publication, idempotency, validation, search, delete/restore and household sharing passed.');
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([once(server,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);
  }
  wrangler('d1','execute','diary-db','--local','--command',"DELETE FROM diary_entries WHERE title LIKE 'weather-%';");
}
