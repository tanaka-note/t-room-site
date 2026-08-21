import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGIN_FAILURE_EVENTS,
  LOGIN_SUCCESS_EVENTS,
  currentJstDayBounds,
  jstDayBounds,
  normalizeAuditService,
  normalizeIdentityId,
  normalizeLinkedService,
  passkeySessionStateMatches,
  resolveInviteExpiry
} from "../src/security-domain.js";

test("Identity ID accepts only A-Z, a-z, 0-9, underscore and hyphen up to 64 characters", () => {
  assert.equal(normalizeIdentityId("family_user-01"), "family_user-01");
  assert.equal(normalizeIdentityId("A".repeat(64)), "A".repeat(64));
  for (const invalid of ["", "a b", "a/b", "あ", "A".repeat(65)]) assert.equal(normalizeIdentityId(invalid), "");
});

test("audit service accepts Security while service links remain limited to three services", () => {
  for (const service of ["security", "cloud", "diary", "billing"]) assert.equal(normalizeAuditService(service), service);
  assert.equal(normalizeLinkedService("security"), "");
  for (const service of ["cloud", "diary", "billing"]) assert.equal(normalizeLinkedService(service), service);
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
    cloudRootFolderId: 42
  };
  const row = {
    service: "cloud",
    identity_id: "family_user-01",
    credential_id: "credential-1",
    link_id: "link-1",
    service_account_id: "folder-member",
    cloud_root_folder_id: 42
  };
  assert.equal(passkeySessionStateMatches(input, row, true), true);
  assert.equal(passkeySessionStateMatches(input, null, true), false, "revoked credential or disabled link produces no active row");
  assert.equal(passkeySessionStateMatches(input, row, false), false, "kill switch invalidates passkey sessions");
  assert.equal(passkeySessionStateMatches({ ...input, credentialId: "revoked" }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, serviceLinkId: "disabled" }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, cloudRootFolderId: 43 }, row, true), false);
  assert.equal(passkeySessionStateMatches({ ...input, serviceAccountId: "other" }, row, true), false, "service account identities must also match exactly");
});
