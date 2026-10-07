import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return next(specifier, context);
} });
const worker = (await import("../src/index.js")).default;
let validPasskey = true, passkeyChecks = 0, passwordChecks = 0;
const env = {
  SESSION_SECRET: randomBytes(32).toString("hex"), SESSION_VERSION: "3", PASSKEY_ENABLED: "true",
  SECURITY: { async validatePasskeySession() { passkeyChecks++; return { valid: validPasskey }; } },
  DB: { prepare(sql) {
    let bindings;
    return {
      bind(...values) { bindings = values; return this; },
      async first() {
        if (sql.includes("password_auth_policy")) { passwordChecks++; return { password_auth_enabled: 1, password_session_epoch: 0 }; }
        if (sql.includes("FROM diary_photos")) return bindings[0] === "11111111-1111-4111-8111-111111111111" ? {
          file_name: "fixture.webp", display_key: "fixture/display", status: "published", deleted_at: null
        } : null;
        if (sql.includes("FROM diary_entries")) return { id: 1 };
        throw new Error("Unexpected fixture SQL");
      },
      async run() { return { meta: { changes: 1 } }; }
    };
  } },
  MEDIA: { async get(key) {
    assert.equal(key, "fixture/display");
    return { httpEtag: '"fixture"', writeHttpMetadata(headers) { headers.set("Content-Type", "image/webp"); },
      body: new Blob([new Uint8Array([1, 2, 3])]).stream() };
  } }
};
function cookie(authMethod = "passkey") {
  const payload = { accountId: authMethod === "passkey" ? "main-admin" : "wife-admin", role: "admin", version: "3", accountVersion: 1,
    authMethod, exp: Math.floor(Date.now() / 1000) + 3600, startedAt: new Date().toISOString(), passwordSessionVersion: 1 };
  if (authMethod === "passkey") Object.assign(payload, { identityId: "fixture", credentialId: "fixture", serviceLinkId: "fixture", serviceAccountId: "main-admin", passkeySessionEpoch: 1 });
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", env.SESSION_SECRET).update(encoded).digest("base64url");
  return `troom_diary_session=${encoded}.${signature}`;
}
const path = "/diary/api/photos/11111111-1111-4111-8111-111111111111/display";
const request = new Request(`https://fixture.test${path}`, { headers: { Cookie: cookie() } });
let response = await worker.fetch(request, env, {});
assert.equal(response.status, 200);
assert.equal(passkeyChecks, 1, "a protected image read must validate once, including response handling");
assert.equal(response.headers.get("Cache-Control"), "private, max-age=3600");
assert.equal(response.headers.has("Set-Cookie"), false, "fixed expiry must remain unchanged");
await response.arrayBuffer();
validPasskey = false;
response = await worker.fetch(request, env, {});
assert.equal(response.status, 401, "even the same Request object must recheck revocation on the next invocation");
assert.equal(passkeyChecks, 2);
validPasskey = true;
response = await worker.fetch(new Request("https://fixture.test/diary/api/entries/1/favorite", {
  method: "POST", headers: { Cookie: cookie(), Origin: "https://fixture.test", "X-Diary-Request": "1" }
}), env, {});
assert.equal(response.status, 200);
assert.equal(passkeyChecks, 4, "mutations must retain the second validation after the handler");
const passwordRequest = new Request(`https://fixture.test${path}`, { headers: { Cookie: cookie("password") } });
response = await worker.fetch(passwordRequest, env, {});
assert.equal(response.status, 401, "main's passkey-only policy must reject retired password cookies");
assert.equal((await worker.fetch(passwordRequest, env, {})).status, 401, "request reuse must never restore password access");
assert.equal(passwordChecks, 0, "retired password access cannot be enabled by a DB policy row");
console.log("Diary request-scoped session validation tests passed.");
