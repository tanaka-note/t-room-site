import assert from "node:assert/strict";
import test from "node:test";
import { buildSecurityAuditEvent } from "../../assets/security-audit-worker.js";

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
  assert.match(source, /if \(session\) enqueueSecurityAudit[\s\S]*eventType: "session_resume"/);
});
