import assert from "node:assert/strict";
import test from "node:test";
import { buildSecurityAuditEvent, recordSecurityAudit } from "../../assets/security-audit-worker.js";

test("session resume carries a hashed session identifier and never the raw cookie value", async () => {
  const request = new Request("https://tanaka-note.com/diary/api/session", {
    headers: { "CF-Connecting-IP": "192.0.2.10", "User-Agent": "Test Browser" }
  });
  const event = await buildSecurityAuditEvent(request, {
    service: "diary",
    eventType: "session_resume",
    outcome: "success",
    identityId: "identity-1",
    serviceLinkId: "link-1",
    serviceAccountId: "main-user",
    role: "user",
    authMethod: "password",
    sessionId: "raw-session-id"
  }, "audit-test-salt");
  assert.equal(event.eventType, "session_resume");
  assert.equal(event.serviceLinkId, "link-1");
  assert.notEqual(event.sessionIdHash, "raw-session-id");
  assert.ok(event.sessionIdHash);
  assert.doesNotMatch(JSON.stringify(event), /raw-session-id|cookie|password_hash|private_key/);
});

test("an unauthenticated session probe is not an audit event", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../diary-worker/src/index.js", import.meta.url), "utf8"));
  assert.match(source, /if \(session\) await recordSecurityAudit[\s\S]*eventType: "session_resume"/);
});

test("successful synchronous audit delivery does not also enqueue", async () => {
  const stored = [];
  const queued = [];
  const result = await recordSecurityAudit({
    AUDIT_IP_SALT: "audit-test-salt",
    SECURITY: { recordAuditEvent: async (event) => stored.push(event) },
    SECURITY_AUDIT: { send: async (event) => queued.push(event) }
  }, new Request("https://tanaka-note.com/diary/api/login"), {
    service: "diary", eventType: "password_login_success", outcome: "success",
    serviceAccountId: "main-admin", role: "global_owner", authMethod: "password", sessionId: "session-one"
  });
  assert.equal(result.mode, "synchronous");
  assert.equal(stored.length, 1);
  assert.equal(queued.length, 0);
  assert.equal(stored[0].eventId, result.eventId);
});

test("synchronous failure enqueues the exact same idempotent event and never rejects login", async () => {
  const attempted = [];
  const queued = [];
  const result = await recordSecurityAudit({
    AUDIT_IP_SALT: "audit-test-salt",
    SECURITY: { recordAuditEvent: async (event) => { attempted.push(event); throw new Error("temporary RPC failure"); } },
    SECURITY_AUDIT: { send: async (event) => queued.push(event) }
  }, new Request("https://tanaka-note.com/diary/api/session"), {
    service: "diary", eventType: "session_resume", outcome: "success",
    identityId: "identity-1", serviceLinkId: "link-1", serviceAccountId: "main-user",
    role: "user", authMethod: "password", sessionId: "session-two"
  });
  assert.equal(result.mode, "queue");
  assert.equal(attempted.length, 1);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], attempted[0]);
  assert.equal(queued[0].eventId, result.eventId);
});

test("audit RPC and Queue failure both fail open without exposing secrets", async () => {
  const result = await recordSecurityAudit({
    SECURITY: { recordAuditEvent: async () => { throw new Error("RPC unavailable"); } },
    SECURITY_AUDIT: { send: async () => { throw new Error("Queue unavailable"); } }
  }, new Request("https://tanaka-note.com/billing/api/login"), {
    service: "billing", eventType: "password_login_success", outcome: "success",
    serviceAccountId: "owner", authMethod: "password", sessionId: "raw-session-id",
    details: { password: "never-store", authProof: "never-store", note: "safe" }
  });
  assert.equal(result.delivered, false);
  assert.equal(result.mode, "none");
  assert.ok(result.eventId);
});

test("all service login and resume success paths await synchronous Security delivery", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const relative of ["../../cloud-worker/src/index.js", "../../diary-worker/src/index.js", "../../billing-worker/src/index.js"]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /await recordSecurityAudit\(env, request, \{[\s\S]{0,240}eventType: "session_resume"/);
    assert.match(source, /await recordSecurityAudit\(env, request, \{[^\n]*eventType: "password_login_success"/);
    assert.match(source, /await recordSecurityAudit\(env, request, \{[^\n]*eventType: "passkey_login_success"/);
  }
});
