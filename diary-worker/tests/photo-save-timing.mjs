import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const worker = (await import("../src/index.js")).default;
const db = new DatabaseSync(":memory:");
const migrations = new URL("../migrations/", import.meta.url);
for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let authChecks = 0, failStorage = false, cleanupGate = null, photoRead = false;
function prepare(sql, args = []) {
  return {
    bind: (...values) => prepare(sql, values),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => {
      if (sql.includes("FROM diary_staged_photos staged") && cleanupGate) await cleanupGate.promise;
      if (sql.includes("FROM diary_photos WHERE entry_id = ? AND id IN")) photoRead = true;
      return { results: db.prepare(sql).all(...args) };
    },
    run: async () => { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
  };
}
const env = {
  SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "3", PASSKEY_ENABLED: "true",
  SECURITY: { async validatePasskeySession() { authChecks++; await delay(20); return { valid: true }; } },
  DB: { prepare, batch: async statements => {
    db.exec("BEGIN");
    try { const results = await Promise.all(statements.map(statement => statement.run())); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } },
  MEDIA: {
    async put(key, stream) { await new Response(stream).arrayBuffer(); await delay(35); if (failStorage) throw new Error("fixture storage failure"); },
    async delete() {}
  }
};
const payload = { accountId: "main-admin", role: "admin", version: "3", accountVersion: 1, authMethod: "passkey",
  exp: Math.floor(Date.now() / 1000) + 3600, startedAt: new Date().toISOString(), identityId: "fixture", credentialId: "fixture",
  serviceLinkId: "fixture", serviceAccountId: "main-admin", passkeySessionEpoch: 1 };
const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
const cookie = `troom_diary_session=${encoded}.${createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url")}`;
async function request(path, body, { slowBody = false } = {}) {
  const headers = { Cookie: cookie, Origin: "https://fixture.test", "X-Diary-Request": "1" };
  let input = new Request(`https://fixture.test/diary/api${path}`, {
    method: "POST", headers: { ...headers, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
    body: body instanceof FormData ? body : JSON.stringify(body)
  });
  if (slowBody) {
    const bytes = await input.arrayBuffer();
    input = new Request(input.url, { method: "POST", headers: input.headers, duplex: "half", body: new ReadableStream({
      async pull(controller) { await delay(60); controller.enqueue(new Uint8Array(bytes)); controller.close(); }
    }, { highWaterMark: 0 }) });
  }
  const response = await worker.fetch(input, env, {});
  return { response, data: await response.json(), timings: Object.fromEntries((response.headers.get("Server-Timing") || "").split(", ").map(value => {
    const [name, duration] = value.split(";dur="); return [name, Number(duration)];
  })) };
}
function photoForm() {
  const form = new FormData();
  form.set("id", randomUUID());
  for (const name of ["original", "display", "thumbnail"]) form.set(name, new File(["fixture"], `${name}.png`, { type: "image/png" }));
  return form;
}
try {
  const session = await request("/photo-upload-sessions", {});
  assert.equal(session.response.status, 200, JSON.stringify(session.data));
  const sessionId = session.data.uploadSession.id;
  authChecks = 0;
  const form = photoForm();
  const upload = await request(`/photo-upload-sessions/${sessionId}/photos`, form, { slowBody: true });
  assert.equal(upload.response.status, 200, JSON.stringify(upload.data));
  assert.equal(authChecks, 2, "instrumentation must retain both mutation validations");
  assert.ok(upload.timings.diary_auth >= 35, "auth includes both current-policy checks");
  assert.ok(upload.timings.diary_receive >= 55, "receive timing includes waiting for request bytes");
  assert.ok(upload.timings.diary_store >= 30, "storage timing includes awaited R2 writes");
  assert.ok(upload.timings.diary_total >= upload.timings.diary_auth + upload.timings.diary_store);
  assert.match(upload.response.headers.get("Server-Timing"), /^(?:diary_[a-z]+;dur=\d+\.\d(?:, |$))+$/,
    "only fixed metric names and numeric durations may enter headers");
  db.exec("INSERT INTO diary_entries(id,entry_date,title,content,status,household_id) VALUES(1,'2026-10-24','fixture','fixture','published','tanaka-household')");
  for (const idempotent of [false, true]) {
    let release;
    cleanupGate = { promise: new Promise(resolve => { release = resolve; }) };
    photoRead = false;
    const commit = request(`/photo-upload-sessions/${sessionId}/commit`, { entryId: 1, photoIds: [form.get("id")] });
    try {
      for (let i = 0; i < 100 && !photoRead; i++) await delay(5);
      assert.equal(photoRead, true, "committed photo reads must not wait for staging cleanup");
    } finally { release(); }
    const result = await commit;
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.idempotent, idempotent);
    assert.equal(result.data.photos.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM diary_staged_photos").get().count, 0,
      "response must still await staging cleanup");
  }
  cleanupGate = null;
  failStorage = true;
  const secondSession = await request("/photo-upload-sessions", {});
  const warn = console.warn;
  console.warn = () => {};
  let failed;
  try { failed = await request(`/photo-upload-sessions/${secondSession.data.uploadSession.id}/photos`, photoForm()); }
  finally { console.warn = warn; }
  assert.equal(failed.response.status, 500);
  assert.ok(failed.timings.diary_store >= 30, "failed storage must retain its timing");
  assert.ok(failed.timings.diary_total >= failed.timings.diary_store);
  console.log("Diary receive/storage/auth timings and parallel commit completion passed.");
} finally { db.close(); }
