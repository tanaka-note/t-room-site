import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PASSKEY_SESSION_TTL_SECONDS,
  PASSWORD_SESSION_TTL_SECONDS,
  sessionCookieValue,
  sessionExpiresAt,
  sessionPolicyForAuthMethod,
  shouldRefreshSession
} from "../../assets/session-policy.mjs";

test("password sessions remain persistent rolling 30-day sessions", () => {
  const policy = sessionPolicyForAuthMethod({ PASSKEY_SESSION_TTL_SECONDS: "43200" }, "password", PASSWORD_SESSION_TTL_SECONDS);
  assert.deepEqual(policy, { authMethod: "password", ttlSeconds: 2592000, persistent: true, rolling: true });
  assert.equal(shouldRefreshSession({ authMethod: "password" }), true);
  assert.match(sessionCookieValue("session", "token", "/", policy, true), /Max-Age=2592000/);
});

test("passkey sessions are absolute 12-hour browser-session cookies", () => {
  const policy = sessionPolicyForAuthMethod({ PASSKEY_SESSION_TTL_SECONDS: "43200" }, "passkey");
  assert.deepEqual(policy, { authMethod: "passkey", ttlSeconds: PASSKEY_SESSION_TTL_SECONDS, persistent: false, rolling: false });
  assert.equal(shouldRefreshSession({ authMethod: "passkey" }), false);
  const cookie = sessionCookieValue("session", "token", "/", policy, true);
  assert.doesNotMatch(cookie, /Max-Age|Expires=/i);
  assert.equal(sessionExpiresAt(1000, policy), 44200);
  assert.equal(sessionExpiresAt(2000, policy, 44200), 44200, "an in-session rewrite cannot extend the absolute expiry");
});

test("passkey TTL configuration fails safe at twelve hours", () => {
  assert.equal(sessionPolicyForAuthMethod({ PASSKEY_SESSION_TTL_SECONDS: "2592000" }, "passkey").ttlSeconds, 43200);
  assert.equal(sessionPolicyForAuthMethod({ PASSKEY_SESSION_TTL_SECONDS: "60" }, "passkey").ttlSeconds, 900);
});

test("all passkey services declare the short policy and no passkey rolling path", async () => {
  const root = new URL("../../", import.meta.url);
  const paths = [
    "diary-worker/wrangler.jsonc", "billing-worker/wrangler.jsonc", "cloud-worker/wrangler.jsonc", "ai-worker/wrangler.jsonc"
  ];
  for (const path of paths) {
    const config = await readFile(new URL(path, root), "utf8");
    assert.match(config, /"PASSKEY_SESSION_TTL_SECONDS"\s*:\s*"43200"/, path);
  }
  for (const path of ["diary-worker/src/index.js", "billing-worker/src/index.js", "cloud-worker/src/index.js"]) {
    const source = await readFile(new URL(path, root), "utf8");
    assert.match(source, /shouldRefreshSession\(session\)/, path);
    assert.match(source, /sessionPolicyForAuthMethod/, path);
    assert.match(source, /expiresAt: session\.authMethod === "password"/, `${path}: rolling expiry must be reported to active-session tracking`);
  }
  const security = await readFile(new URL("security-worker/src/index.js", root), "utf8");
  assert.match(security, /authMethod: "passkey"/);
  assert.match(security, /sessionCookieValue\(name, token, BASE_PATH, \{ persistent: false/);
});
