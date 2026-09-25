import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(realpathSync(new URL("../node_modules/wrangler/package.json", import.meta.url)));
const { build } = require("esbuild");
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const result = await build({
  stdin: { contents: source, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "index.js" },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "cloudflare-workers-test-boundary",
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class WorkerEntrypoint {}" }));
    }
  }]
});
const worker = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const origin = "https://tanaka-note.com";
const base = `${origin}/downloader2/api`;
const sessionSecret = "7d5f65a8586996cdd5c6e44a1d8eb2599f9291a379ad10c2be4f8ecefce25573";

function environment(handoff = {}) {
  return {
    SESSION_SECRET: sessionSecret,
    SESSION_VERSION: "1",
    PASSKEY_ENABLED: "true",
    SECURITY: {
      redeemHandoff: async () => ({
        identityId: "primary-admin", identityDisplayName: "第一管理者", credentialId: "credential",
        serviceLinkId: "link", serviceAccountId: "owner", sessionEpoch: 3, ...handoff
      }),
      validatePasskeySession: async (input) => ({ valid: input.service === "downloader2" && input.identityId === "primary-admin" && input.serviceAccountId === "owner" }),
      recordAuditEvent: async () => ({ ok: true })
    }
  };
}

function request(path, { method = "GET", body, cookie, native = false } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (body && !native) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return new Request(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

async function login(env) {
  const response = await worker.handleRequest(request("/passkey/handoff", { method: "POST", body: { handoffToken: "one-time" } }), env);
  assert.equal(response.status, 200);
  return response.headers.get("Set-Cookie").split(";", 1)[0];
}

test("Downloader 2 rejects unauthenticated and non-owner Passkey handoffs", async () => {
  await assert.rejects(worker.handleRequest(request("/session"), environment()), (error) => error.status === 401);
  await assert.rejects(login(environment({ identityId: "other" })), (error) => error.status === 401);
  await assert.rejects(login(environment({ serviceAccountId: "other" })), (error) => error.status === 401);
});

test("owner Passkey session is accepted and revalidated by Security Center", async () => {
  const env = environment();
  const cookie = await login(env);
  const response = await worker.handleRequest(request("/session", { cookie }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, user: { displayName: "第一管理者", role: "owner" } });
});

test("pairing token is signed, device-bound and redeemable without browser credentials", async () => {
  const env = environment();
  const cookie = await login(env);
  const deviceChallenge = Buffer.alloc(32, 7).toString("base64url");
  const issued = await worker.handleRequest(request("/pairing/challenge", { method: "POST", cookie, body: { deviceChallenge } }), env, { waitUntil() {} });
  const challenge = await issued.json();
  assert.equal(challenge.token.split(".").length, 2);
  const redeemed = await worker.handleRequest(request("/pairing/redeem", { method: "POST", native: true, body: { token: challenge.token, deviceChallenge } }), env);
  assert.deepEqual(await redeemed.json(), { valid: true, expiresAt: challenge.expiresAt });
  await assert.rejects(worker.handleRequest(request("/pairing/redeem", { method: "POST", native: true, body: { token: `${challenge.token}x`, deviceChallenge } }), env), (error) => error.status === 401);
  await assert.rejects(worker.handleRequest(request("/pairing/redeem", { method: "POST", native: true, body: { token: challenge.token, deviceChallenge: Buffer.alloc(32, 8).toString("base64url") } }), env), (error) => error.status === 401);
});
