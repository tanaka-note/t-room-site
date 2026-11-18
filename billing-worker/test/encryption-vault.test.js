import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBillingVault, unlockBillingVault } from "../public/billing-crypto.mjs";
import { prepareBillingVault } from "../public/billing-key-client.mjs";
import { fixture, payload } from "./performance-fixture.mjs";

test("ordinary Billing sessions prepare separate passkey vaults and restrict the recipient directory", async () => {
  const f = fixture();
  const memberPRF = crypto.getRandomValues(new Uint8Array(32));
  const ownerPRF = crypto.getRandomValues(new Uint8Array(32));
  try {
    const legacy = await f.login("chiharu");
    assert.equal(legacy.body.prepareEncryptionKey, undefined);
    assert.equal((await f.request("encryption/vault", legacy.cookie)).status, 404);
    f.env.BILLING_KEY_PREPARATION_ENABLED = "true";
    f.securityDb.exec(readFileSync(new URL("../../security-worker/e2ee/billing-vaults.sql", import.meta.url), "utf8"));
    f.securityDb.exec(`INSERT INTO security_identities (id,display_name,status,is_security_admin)
        VALUES ('primary-admin','Fixture admin','active',1);
      INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,prf_enabled,status)
        VALUES ('YmlsbGluZy1vd25lcg','primary-admin','AQI','AQI',1,'active');
      UPDATE security_credentials SET prf_enabled=1 WHERE credential_id='Y3JlZGVudGlhbA';
      UPDATE security_service_links SET status='disabled' WHERE id='link-owner';
      INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status)
        VALUES ('fixture-primary-billing','primary-admin','billing','owner','Fixture','active');`);
    f.security.env.BILLING_AUTH = {
      describeAccount: async ({ accountId }) => ({ valid: true, role: accountId === "owner" ? "owner" : "member" }),
      listLinkTargets: async () => ({ targets: [{ accountId: "chiharu", role: "member" }, { accountId: "owner", role: "owner" }] })
    };
    const member = await f.login("chiharu");
    const owner = await f.login("owner", "primary-admin", "fixture-primary-billing", "YmlsbGluZy1vd25lcg");
    assert.equal(member.body.prepareEncryptionKey, true);
    assert.equal(owner.body.prepareEncryptionKey, true);
    const api = (cookie, afterWrite) => async (path, options) => {
      const result = await f.request(path.slice(1), cookie, options);
      if (result.status !== 200) throw Object.assign(new Error(result.body.error), { status: result.status });
      if (options?.method === "POST") afterWrite?.();
      return result.body;
    };
    const memberApi = api(member.cookie);
    const memberAuth = { credentialId: "Y3JlZGVudGlhbA", prfOutput: memberPRF };
    const ownerAuth = { credentialId: "YmlsbGluZy1vd25lcg", prfOutput: ownerPRF };
    await assert.rejects(prepareBillingVault(memberApi, ownerAuth), /パスキー/);
    await assert.rejects(prepareBillingVault(memberApi, { credentialId: memberAuth.credentialId }), /パスキー/);
    const ownerWithLostEnrollmentResponse = api(owner.cookie, () => { throw new TypeError("fixture lost response"); });
    await prepareBillingVault(ownerWithLostEnrollmentResponse, ownerAuth);
    await prepareBillingVault(memberApi, memberAuth);
    const firstMemberVault = (await memberApi("/encryption/vault")).vault;
    const competing = await createBillingVault(memberPRF, memberAuth.credentialId);
    assert.notDeepEqual(competing.recipient.publicKey, firstMemberVault.recipient.publicKey);
    const response = await memberApi("/encryption/vault", { method: "POST", body: { vault: competing } });
    assert.deepEqual(response.vault, firstMemberVault);
    assert.equal((await unlockBillingVault(memberPRF, memberAuth.credentialId, response.vault)).writer, null);
    await assert.rejects(memberApi("/encryption/recipients"), error => error.status === 403);
    const { recipients } = await api(owner.cookie)("/encryption/recipients");
    assert.deepEqual(recipients.map(row => row.accountId), ["chiharu", "owner"]);
    assert.deepEqual(recipients[0].publicKey, firstMemberVault.recipient.publicKey);
    assert.doesNotMatch(JSON.stringify(recipients), /ciphertext|writer_iv|private/);
    const stale = f.sign({ ...payload(owner.cookie), startedAt: new Date(Date.now() - 301000).toISOString() });
    await assert.rejects(api(stale)("/encryption/vault", { method: "POST", body: { vault: competing } }), error => error.status === 409);
    const wrongRoleVault = await createBillingVault(memberPRF, memberAuth.credentialId, { signing: true });
    await assert.rejects(memberApi("/encryption/vault", { method: "POST", body: { vault: wrongRoleVault } }), error => error.status === 400);
    f.securityDb.exec("UPDATE security_service_links SET status='disabled' WHERE id='link-chiharu'");
    await assert.rejects(memberApi("/encryption/vault"), error => error.status === 401);
    assert.deepEqual((await api(owner.cookie)("/encryption/recipients")).recipients.map(row => row.accountId), ["owner"]);
  } finally {
    memberPRF.fill(0);
    ownerPRF.fill(0);
    f.close();
  }
});
