import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fixture, payload, seedLedger } from "./performance-fixture.mjs";
import {
  billingLedgerKeys, billingRecordId, createBillingVault, openBillingRecord, unlockBillingVault,
  unwrapBillingLedgerKey, wrapBillingLedgerKey
} from "../public/billing-crypto.mjs";
import {
  billingMigrationSources, billingMonthlySources, readBillingEncryptedMonth, sealBillingMigrationLedger, verifyBillingMigrationLedger
} from "../public/billing-migration.mjs";
import { freezeBillingMigrationSource, readBillingMigrationPage } from "../src/migration-source.js";
import {
  attestBillingCandidate, loadVerifiedBillingCandidate, readBillingCandidate, reserveBillingCandidate, writeBillingCandidatePage
} from "../src/migration-candidate.js";

test("the frozen migration source pages retain deletions and allow later metadata-only audit events", async () => {
  const f = fixture();
  try {
    const generation = crypto.randomUUID();
    f.db.exec(readFileSync(new URL("../encryption/migration-preparation.sql", import.meta.url), "utf8"));
    seedLedger(f);
    f.db.exec(`UPDATE billing_entries SET deleted_at='2026-11-01' WHERE id=1;
      INSERT INTO billing_opening_balances (account_id,effective_date,balance_yen,updated_by)
        VALUES ('chiharu','2026-10-01',-13,'owner');
      INSERT INTO billing_audit_logs (event_type,actor_account_id,target_account_id,entry_id,details_json)
        VALUES ('entry_deleted','owner','chiharu',1,'{"description":"private-fixture"}');`);
    const entry = f.db.prepare(`INSERT INTO billing_entries
      (account_id,document_type,entry_date,category,amount_yen,description,created_by)
      VALUES ('chiharu','invoice','2026-10-01','purchase',20,'Fixture','owner')`);
    for (let i = 0; i < 28; i++) entry.run();
    const state = await freezeBillingMigrationSource(f.env.DB, generation);
    assert.deepEqual(await freezeBillingMigrationSource(f.env.DB, generation), state);
    await assert.rejects(freezeBillingMigrationSource(f.env.DB, crypto.randomUUID()), /generation conflict/);
    assert.throws(() => entry.run(), /migration in progress/);
    assert.throws(() => f.db.exec("UPDATE billing_entries SET amount_yen=100 WHERE id=1"), /migration in progress/);
    assert.throws(() => f.db.exec("DELETE FROM billing_opening_balances"), /migration in progress/);
    assert.throws(() => f.db.exec("DELETE FROM billing_settlements WHERE id=1"), /migration in progress/);
    assert.throws(() => f.db.exec("UPDATE billing_audit_logs SET details_json='{}' WHERE id=1"), /migration in progress/);
    f.db.exec("INSERT INTO billing_audit_logs (event_type,actor_account_id) VALUES ('session_resume','owner')");
    const options = { generation, collection: "entries", accountId: "chiharu" };
    const first = await readBillingMigrationPage(f.env.DB, options);
    assert.equal(first.rows.length, 50);
    assert.equal(first.rows[0].deleted_at, "2026-11-01");
    assert.ok(first.rows.every(row => row.account_id === "chiharu"));
    const second = await readBillingMigrationPage(f.env.DB, { ...options, after: first.next });
    assert.equal(second.rows.length, 2);
    assert.equal(second.next, null);
    assert.equal((await readBillingMigrationPage(f.env.DB, { generation, collection: "auditLogs" })).rows.length, 1);
    await assert.rejects(readBillingMigrationPage(f.env.DB, { ...options, generation: crypto.randomUUID() }), /generation conflict/);
  } finally {
    f.close();
  }
});

test("the migration recovery envelope requires a fresh primary-admin Billing passkey and live Cloud admin link", async () => {
  const f = fixture();
  try {
    const owner = await f.login();
    const member = await f.login("chiharu");
    assert.equal((await f.request("encryption/recovery-context", owner.cookie)).status, 403);
    assert.equal((await f.request("encryption/recovery-context", member.cookie)).status, 403);
    f.securityDb.exec(`INSERT INTO security_identities (id,display_name,status,is_security_admin)
      VALUES ('primary-admin','Fixture admin','active',1);
      UPDATE security_credentials SET identity_id='primary-admin', prf_enabled=1 WHERE credential_id='Y3JlZGVudGlhbA';
      UPDATE security_service_links SET status='disabled' WHERE id='link-owner';
      INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status)
      VALUES ('fixture-primary-billing','primary-admin','billing','owner','Fixture','active'),
        ('fixture-primary-cloud','primary-admin','cloud','admin','Fixture','active');
      INSERT INTO security_tcloud_key_envelopes
        (id,identity_id,credential_id,service_link_id,envelope_type,encrypted_payload,payload_iv)
      SELECT 'fixture-envelope','primary-admin','Y3JlZGVudGlhbA',id,'admin_private_prf','fixture-ciphertext','fixture-iv'
      FROM security_service_links WHERE identity_id='primary-admin' AND service='cloud' AND service_account_id='admin';`);
    const publicKey = { kty: "RSA", n: "fixture-public-modulus", e: "AQAB" };
    f.security.env.BILLING_AUTH = { describeAccount: async ({ accountId }) => ({ valid: accountId === "owner", role: "owner" }) };
    f.security.env.CLOUD_AUTH = { getPrimaryAdminCryptoConfig: async () => ({
      initialized: true, publicKeyJwk: publicKey, adminPrivateCipher: "must-not-be-returned"
    }) };
    const primaryLink = f.securityDb.prepare("SELECT id FROM security_service_links WHERE identity_id='primary-admin' AND service='billing' AND service_account_id='owner'").get().id;
    const primary = await f.login("owner", "primary-admin", primaryLink);
    assert.equal(primary.status, 200);
    const fresh = await f.request("encryption/recovery-context", primary.cookie);
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body, { publicKey, envelope: { encryptedPayload: "fixture-ciphertext", payloadIv: "fixture-iv" } });
    const stale = f.sign({ ...payload(primary.cookie), startedAt: new Date(Date.now() - 301000).toISOString() });
    assert.equal((await f.request("encryption/recovery-context", stale)).status, 409);
    f.securityDb.exec("UPDATE security_service_links SET status='disabled' WHERE identity_id='primary-admin' AND service='cloud'");
    assert.equal((await f.request("encryption/recovery-context", primary.cookie)).status, 409);
  } finally {
    f.close();
  }
});

test("sealed migration preserves source rows and rejects tampering, scope changes, and wrong recipients", async () => {
  const f = fixture();
  try {
    seedLedger(f);
    f.db.exec(`UPDATE billing_entries SET deleted_at='2026-11-01' WHERE id=1;
      INSERT INTO billing_opening_balances (account_id,effective_date,balance_yen,updated_by)
        VALUES ('chiharu','2026-10-01',-13,'owner');
      INSERT INTO billing_audit_logs (event_type,actor_account_id,target_account_id,entry_id,details_json)
        VALUES ('entry_deleted','owner','chiharu',1,'{"description":"private-fixture"}');`);
    const rows = (table, account) => f.db.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(account);
    const sources = billingMigrationSources({
      entries: rows("billing_entries", "chiharu"),
      settlements: rows("billing_settlements", "chiharu"),
      openingBalances: rows("billing_opening_balances", "chiharu"),
      auditLogs: f.db.prepare("SELECT * FROM billing_audit_logs").all()
    });
    f.db.exec(readFileSync(new URL("../encryption/migration-preparation.sql", import.meta.url), "utf8"));
    const migration = crypto.randomUUID();
    await freezeBillingMigrationSource(f.env.DB, migration);
    const recipient = { identityId: "fixture-identity", credentialId: "fixture-credential", serviceLinkId: "fixture-link" };
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const material = crypto.getRandomValues(new Uint8Array(32));
    const auditMaterial = crypto.getRandomValues(new Uint8Array(32));
    try {
      const vault = await createBillingVault(prf, recipient.credentialId, { signing: true });
      await assert.rejects(unlockBillingVault(prf, "other-credential", vault));
      const { writer, recipient: recipientKey } = await unlockBillingVault(prf, recipient.credentialId, vault);
      assert.equal(writer.extractable, false);
      assert.equal(recipientKey.extractable, false);
      const scope = { ledgerId: crypto.randomUUID(), generation: 1 };
      const auditScope = { ledgerId: crypto.randomUUID(), generation: 1 };
      const keys = await billingLedgerKeys(material, scope);
      const auditKeys = await billingLedgerKeys(auditMaterial, auditScope);
      const financial = [...sources.ledger, ...billingMonthlySources({ id: "chiharu", displayName: "田中千晴" }, sources.ledger)];
      const wrapped = await wrapBillingLedgerKey(material, scope, recipient, vault.recipient.publicKey);
      const opened = await unwrapBillingLedgerKey(wrapped, scope, recipient, recipientKey);
      assert.deepEqual(opened, material);
      opened.fill(0);
      await assert.rejects(unwrapBillingLedgerKey(wrapped, scope, { ...recipient, serviceLinkId: "other-link" }, recipientKey));
      await assert.rejects(unwrapBillingLedgerKey(wrapped, { ...scope, generation: 2 }, recipient, recipientKey));
      const initial = await sealBillingMigrationLedger({ scope, keys, revision: 1, sources: financial, writer });
      const audit = await sealBillingMigrationLedger({ scope: auditScope, keys: auditKeys, revision: 1, sources: sources.audit, writer });
      const verify = replacement => verifyBillingMigrationLedger({
        scope, keys, state: replacement, sources: financial, writerPublicKey: vault.writer.publicKey
      });
      assert.doesNotMatch(JSON.stringify({ initial, audit, vault }), /private-fixture|account_id|2026-11-01|chiharu/);
      assert.equal(await verify(initial), financial.length);
      const writerPublicKey = vault.writer.publicKey;
      const header = { revision: initial.revision, recordCount: initial.records.length };
      await reserveBillingCandidate(f.env.DB, migration, scope, "chiharu", header);
      await reserveBillingCandidate(f.env.DB, migration, scope, "chiharu", header);
      await assert.rejects(loadVerifiedBillingCandidate(f.env.DB, migration, scope, writerPublicKey), /staging verification/);
      await writeBillingCandidatePage(f.env.DB, migration, scope, initial.records.slice(0, 7));
      await assert.rejects(attestBillingCandidate(f.env.DB, migration, scope, initial, writerPublicKey), /attestation verification/);
      const staged = await readBillingCandidate(f.env.DB, migration, scope);
      const state = await sealBillingMigrationLedger({ scope, keys, revision: 1, sources: financial, writer, stagedRecords: staged.records });
      assert.deepEqual(state.records.slice(0, 7), staged.records);
      for (let offset = 0; offset < state.records.length; offset += 32) {
        const page = state.records.slice(offset, offset + 32);
        await writeBillingCandidatePage(f.env.DB, migration, scope, page);
        await writeBillingCandidatePage(f.env.DB, migration, scope, page);
      }
      await attestBillingCandidate(f.env.DB, migration, scope, state, writerPublicKey);
      await attestBillingCandidate(f.env.DB, migration, scope, state, writerPublicKey);
      const stored = await loadVerifiedBillingCandidate(f.env.DB, migration, scope, writerPublicKey);
      assert.equal(await verify(stored), financial.length);
      const owner = await f.login();
      for (const month of ["2026-07", "2026-10", "2026-12"]) {
        const requests = [];
        const summary = await readBillingEncryptedMonth({ scope, keys, revision: 1, month, loadRecord(id) {
          requests.push(id);
          return stored.records.find(record => record.id === id);
        } });
        assert.ok(requests.every(id => /^[A-Za-z0-9_-]{43}$/.test(id)));
        assert.equal(requests.length, month === "2026-10" ? 2 : 1);
        assert.deepEqual(summary, (await f.request(`summary?accountId=chiharu&month=${month}`, owner.cookie)).body);
      }
      const changed = { ...state.records[0], iv: "A".repeat(16) };
      await assert.rejects(writeBillingCandidatePage(f.env.DB, migration, scope, [changed]), /ciphertext changed/);
      const extra = { ...state.records[0], id: "A".repeat(43) };
      await assert.rejects(writeBillingCandidatePage(f.env.DB, migration, scope, [extra]), /staged_count/);
      assert.equal(await verify(await loadVerifiedBillingCandidate(f.env.DB, migration, scope, writerPublicKey)), financial.length);
      assert.equal(await verify({ ...state, records: [...state.records].reverse() }), financial.length);
      await assert.rejects(verify({ ...state, revision: 2 }));
      await assert.rejects(verify({ ...state, records: state.records.slice(1) }));
      await assert.rejects(openBillingRecord(keys, auditScope, audit.records[0]));
      const deletedId = await billingRecordId(keys, "entry", "1");
      const deleted = await openBillingRecord(keys, scope, state.records.find(record => record.id === deletedId));
      assert.equal(deleted.data.deleted_at, "2026-11-01");
      const altered = financial.map(source => source.sourceId === "1" && source.kind === "entry"
        ? { ...source, data: { ...source.data, amount_yen: 10 } } : source);
      await assert.rejects(verifyBillingMigrationLedger({
        scope, keys, state, sources: altered, writerPublicKey: vault.writer.publicKey
      }), /source comparison/);
    } finally {
      prf.fill(0);
      material.fill(0);
      auditMaterial.fill(0);
    }
  } finally {
    f.close();
  }
});
