import assert from "node:assert/strict";
import test from "node:test";
import { validateServicePasskeySession } from "../../assets/passkey-session-validation.mjs";

const passkey = {
  authMethod: "passkey",
  identityId: "family_user",
  credentialId: "credential-1",
  serviceLinkId: "link-1",
  serviceAccountId: "main-user",
  passkeySessionEpoch: 4
};

test("password sessions remain independent from passkey revocation and kill switch", async () => {
  let called = false;
  const env = { PASSKEY_ENABLED: "false", SECURITY: { validatePasskeySession: async () => { called = true; return { valid: false }; } } };
  assert.equal(await validateServicePasskeySession({ authMethod: "password" }, env, "diary"), true);
  assert.equal(await validateServicePasskeySession({ authMethod: "password", identityId: "unexpected-passkey-binding" }, env, "diary"), false);
  assert.equal(await validateServicePasskeySession({ identityId: "legacy-passkey", credentialId: "credential" }, env, "diary"), false);
  assert.equal(called, false);
});

test("passkey sessions require all revocation identifiers and an enabled kill switch", async () => {
  const binding = { validatePasskeySession: async () => ({ valid: true }) };
  let called = false;
  assert.equal(await validateServicePasskeySession(passkey, { PASSKEY_ENABLED: "false", SECURITY: { validatePasskeySession: async () => { called = true; return { valid: true }; } } }, "diary"), false);
  assert.equal(called, false, "a service-local kill switch fails closed without mutating Security global runtime state");
  for (const field of ["identityId", "credentialId", "serviceLinkId", "serviceAccountId", "passkeySessionEpoch"]) {
    assert.equal(await validateServicePasskeySession({ ...passkey, [field]: null }, { PASSKEY_ENABLED: "true", SECURITY: binding }, "diary"), false, field);
  }
});

test("credential revoke and service-link removal reject the next protected service access", async () => {
  for (const service of ["cloud", "diary", "billing"]) {
    let active = true;
    const env = { PASSKEY_ENABLED: "true", SECURITY: { validatePasskeySession: async () => ({ valid: active }) } };
    assert.equal(await validateServicePasskeySession(passkey, env, service, service === "cloud" ? 42 : null), true);
    active = false;
    assert.equal(await validateServicePasskeySession(passkey, env, service, service === "cloud" ? 42 : null), false);
  }
});

test("service validation forwards the exact credential, link, account and Cloud root", async () => {
  let received;
  const env = { PASSKEY_ENABLED: "true", SECURITY: { validatePasskeySession: async (input) => { received = input; return { valid: true }; } } };
  assert.equal(await validateServicePasskeySession({ ...passkey, serviceAccountId: "folder-member" }, env, "cloud", 42), true);
  assert.deepEqual(received, {
    service: "cloud",
    identityId: "family_user",
    credentialId: "credential-1",
    serviceLinkId: "link-1",
    serviceAccountId: "folder-member",
    cloudRootFolderId: 42,
    sessionEpoch: 4
  });
});

test("each service-local kill switch is isolated from other services", async () => {
  const calls = [];
  const binding = { validatePasskeySession: async (input) => { calls.push(input.service); return { valid: true }; } };
  for (const disabled of ["cloud", "diary", "billing"]) {
    for (const service of ["cloud", "diary", "billing"]) {
      const enabled = service !== disabled;
      const result = await validateServicePasskeySession(passkey, { PASSKEY_ENABLED: String(enabled), SECURITY: binding }, service, service === "cloud" ? 42 : null);
      assert.equal(result, enabled, `${disabled}=off must only disable ${disabled}`);
    }
  }
  assert.deepEqual(calls, ["diary", "billing", "cloud", "billing", "cloud", "diary"]);
});
