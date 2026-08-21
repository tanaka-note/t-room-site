import assert from "node:assert/strict";
import test from "node:test";
import { validateServicePasskeySession } from "../../assets/passkey-session-validation.mjs";

const passkey = {
  authMethod: "passkey",
  identityId: "family_user",
  credentialId: "credential-1",
  serviceLinkId: "link-1",
  serviceAccountId: "main-user"
};

test("password sessions remain independent from passkey revocation and kill switch", async () => {
  let called = false;
  const env = { PASSKEY_ENABLED: "false", SECURITY: { validatePasskeySession: async () => { called = true; return { valid: false }; } } };
  assert.equal(await validateServicePasskeySession({ authMethod: "password" }, env, "diary"), true);
  assert.equal(called, false);
});

test("passkey sessions require all revocation identifiers and an enabled kill switch", async () => {
  const binding = { validatePasskeySession: async () => ({ valid: true }) };
  assert.equal(await validateServicePasskeySession(passkey, { PASSKEY_ENABLED: "false", SECURITY: binding }, "diary"), false);
  for (const field of ["identityId", "credentialId", "serviceLinkId", "serviceAccountId"]) {
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
    cloudRootFolderId: 42
  });
});
