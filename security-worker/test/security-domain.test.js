import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGIN_FAILURE_EVENTS,
  LOGIN_SUCCESS_EVENTS,
  MAX_CREDENTIAL_ID_BYTES,
  auditRetentionCutoff,
  bootstrapAttemptCutoff,
  canonicalServiceLinks,
  currentJstDayBounds,
  decodeAuditCursor,
  encodeAuditCursor,
  jstDayBounds,
  normalizeAuditService,
  normalizeIdentityId,
  normalizeLinkedService,
  normalizeUtcTimestamp,
  passkeySessionStateMatches,
  resolveInviteExpiry,
  validCredentialId
} from "../src/security-domain.js";

test("Identity ID accepts only A-Z, a-z, 0-9, underscore and hyphen up to 64 characters", () => {
  assert.equal(normalizeIdentityId("family_user-01"), "family_user-01");
  assert.equal(normalizeIdentityId("A".repeat(64)), "A".repeat(64));
  for (const invalid of ["", "a b", "a/b", "あ", "A".repeat(65)]) assert.equal(normalizeIdentityId(invalid), "");
});

test("audit and service-link normalization include the Passkey-only AI service", () => {
  for (const service of ["security", "cloud", "diary", "billing", "ai"]) assert.equal(normalizeAuditService(service), service);
  assert.equal(normalizeLinkedService("security"), "");
  for (const service of ["cloud", "diary", "billing", "ai"]) assert.equal(normalizeLinkedService(service), service);
});

test("new invitations and reinvitations share strict preset and custom expiry rules", () => {
  const now = 2_000_000_000;
  for (const seconds of [3600, 21600, 86400, 259200, 604800]) {
    assert.equal(resolveInviteExpiry({ expiresIn: seconds }, now, 30), now + seconds);
  }
  assert.equal(resolveInviteExpiry({ expiresAt: now + 8 * 86400 }, now, 30), now + 8 * 86400);
  assert.throws(() => resolveInviteExpiry({}, now, 30), /有効期限/);
  assert.throws(() => resolveInviteExpiry({ expiresIn: "custom" }, now, 30), /有効期限/);
  assert.throws(() => resolveInviteExpiry({ expiresAt: Number.NaN }, now, 30), /日時指定/);
  assert.throws(() => resolveInviteExpiry({ expiresAt: now + 3599 }, now, 30), /日時指定/);
  assert.throws(() => resolveInviteExpiry({ expiresAt: now + 31 * 86400 }, now, 30), /日時指定/);
});

test("dashboard and audit date ranges use Asia/Tokyo day boundaries", () => {
  assert.deepEqual(jstDayBounds("2026-08-21"), {
    date: "2026-08-21",
    start: "2026-08-20T15:00:00.000Z",
    end: "2026-08-21T15:00:00.000Z"
  });
  assert.equal(currentJstDayBounds(new Date("2026-08-20T14:59:59.000Z")).date, "2026-08-20");
  assert.equal(currentJstDayBounds(new Date("2026-08-20T15:00:00.000Z")).date, "2026-08-21");
  assert.equal(jstDayBounds("2026-02-30"), null);
});

test("dashboard login categories include password and passkey failures without LIKE heuristics", () => {
  assert.deepEqual(LOGIN_SUCCESS_EVENTS, ["password_login_success", "passkey_login_success"]);
  assert.ok(LOGIN_FAILURE_EVENTS.includes("password_login_failure"));
  assert.ok(LOGIN_FAILURE_EVENTS.includes("passkey_authentication_failure"));
  assert.ok(LOGIN_FAILURE_EVENTS.includes("bootstrap_auth_failure"));
});

test("passkey session validation fails closed after credential, link, root or kill-switch changes", () => {
  const input = {
    service: "cloud",
    identityId: "family_user-01",
    credentialId: "credential-1",
    serviceLinkId: "link-1",
    serviceAccountId: "folder-member",
      cloudRootFolderId: 42,
      sessionEpoch: 7
  };
  const row = {
    service: "cloud",
    identity_id: "family_user-01",
    credential_id: "credential-1",
    link_id: "link-1",
    service_account_id: "folder-member",
    cloud_root_folder_id: 42,
    session_epoch: 7
  };
  assert.equal(passkeySessionStateMatches(input, row, true), true);
  assert.equal(passkeySessionStateMatches(input, null, true), false, "revoked credential or disabled link produces no active row");
  assert.equal(passkeySessionStateMatches(input, row, false), false, "kill switch invalidates passkey sessions");
  assert.equal(passkeySessionStateMatches({ ...input, credentialId: "revoked" }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, serviceLinkId: "disabled" }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, cloudRootFolderId: 43 }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, serviceAccountId: "other" }, row, true), false, "service account identities must also match exactly");
  assert.equal(passkeySessionStateMatches({ ...input, sessionEpoch: 6 }, row, true), false, "kill-switch generations cannot revive");
});

test("service-link hashing is deterministic for numeric roots, NULL roots and mixed services", () => {
  const rows = [
    { service: "cloud", accountId: "folder-member", rootFolderId: 10 },
    { service: "diary", accountId: "main-user", rootFolderId: null },
    { service: "cloud", accountId: "folder-member", rootFolderId: 2 },
    { service: "billing", accountId: "owner", rootFolderId: null }
  ];
  const expected = canonicalServiceLinks(rows);
  assert.deepEqual(expected.map((row) => row.cloud_root_folder_id), [null, 2, 10, null]);
  assert.deepEqual(canonicalServiceLinks([...rows].reverse()), expected);
  assert.deepEqual(canonicalServiceLinks(expected), expected);
});

test("SQLite UTC timestamps are normalized before browser display", () => {
  assert.equal(normalizeUtcTimestamp("2026-08-21 03:04:05"), "2026-08-21T03:04:05.000Z");
  assert.equal(normalizeUtcTimestamp("2026-08-21T03:04:05Z"), "2026-08-21T03:04:05.000Z");
  assert.equal(normalizeUtcTimestamp(null), null);
});

test("credential IDs accept long base64url values but reject malformed and oversized paths", () => {
  const maximum = Buffer.alloc(MAX_CREDENTIAL_ID_BYTES, 7).toString("base64url");
  assert.equal(validCredentialId(maximum), maximum);
  assert.equal(validCredentialId(Buffer.alloc(MAX_CREDENTIAL_ID_BYTES + 1, 7).toString("base64url")), "");
  assert.equal(validCredentialId(""), "");
  assert.equal(validCredentialId("***"), "");
  assert.equal(validCredentialId("a"), "", "invalid base64url length is rejected");
  assert.equal(validCredentialId("AB"), "", "non-canonical trailing bits are rejected");
});

test("bootstrap lockout cutoff is a UTC ISO instant across UTC and JST boundaries", () => {
  assert.equal(bootstrapAttemptCutoff(Date.parse("2026-08-21T00:05:00.000Z")), "2026-08-20T23:50:00.000Z");
  assert.equal(bootstrapAttemptCutoff(Date.parse("2026-08-21T15:05:00.000Z")), "2026-08-21T14:50:00.000Z");
});

test("audit retention cutoff uses the same UTC ISO representation across UTC and JST boundaries", () => {
  assert.equal(auditRetentionCutoff(180, Date.parse("2026-08-21T00:05:00.000Z")), "2026-02-22T00:05:00.000Z");
  assert.equal(auditRetentionCutoff(30, Date.parse("2026-08-21T15:05:00.000Z")), "2026-07-22T15:05:00.000Z");
});

test("audit cursor preserves the exact composite ordering key and rejects malformed input", () => {
  for (const occurredAt of ["2026-08-21T03:04:05.000Z", "2026-08-21 03:04:05"]) {
    const cursor = encodeAuditCursor({ occurred_at: occurredAt, event_id: "event_10-a" });
    assert.deepEqual(decodeAuditCursor(cursor), { occurredAt, eventId: "event_10-a" });
  }
  for (const invalid of ["", "***", "a", Buffer.from('{"v":1,"t":"bad","id":"event"}').toString("base64url")]) {
    assert.throws(() => decodeAuditCursor(invalid), /cursor/);
  }
});
