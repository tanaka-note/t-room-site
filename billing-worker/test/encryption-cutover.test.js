import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { billingCheckpoint } from "../../backup-worker/src/billing-checkpoint.js";
import { BILLING_ENCRYPTED_MIGRATION } from "../../backup-worker/src/billing-encrypted.js";
import { readExportManifest, saveExport } from "../../backup-worker/src/export-backup.js";
import { Bucket } from "../../backup-worker/test/fixtures.mjs";
import { exportEnv, exportFetcher } from "../../backup-worker/test/export-fixtures.mjs";
import { restoreIsolated } from "../../backup-worker/tools/restore-isolated.mjs";
import { encryptedBillingApp } from "../public/billing-encrypted-app.mjs";
import { prepareBillingVault } from "../public/billing-key-client.mjs";
import { stageBillingMigration } from "../public/billing-migration-client.mjs";
import { restoreBillingCheckpoint } from "../public/billing-checkpoint-restore.mjs";
import { fixture, seedLedger } from "./performance-fixture.mjs";

test("ordinary admin login stages, restores and opens encrypted Billing; normal mutations preserve members and audit", async () => {
  const f = fixture();
  const ownerPRF = crypto.getRandomValues(new Uint8Array(32)), memberPRF = crypto.getRandomValues(new Uint8Array(32));
  try {
    f.db.exec(readFileSync(new URL("../encryption/migration-preparation.sql",import.meta.url),"utf8"));
    f.securityDb.exec(readFileSync(new URL("../../security-worker/e2ee/billing-vaults.sql",import.meta.url),"utf8"));
    f.securityDb.exec(`INSERT INTO security_identities (id,display_name,status,is_security_admin)
        VALUES ('primary-admin','Fixture admin','active',1);
      INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,prf_enabled,status)
        VALUES ('YmlsbGluZy1vd25lcg','primary-admin','AQI','AQI',1,'active');
      UPDATE security_credentials SET prf_enabled=1 WHERE credential_id='Y3JlZGVudGlhbA';
      UPDATE security_service_links SET status='disabled' WHERE id='link-owner';
      INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status)
        VALUES ('fixture-primary-billing','primary-admin','billing','owner','Fixture','active');`);
    f.security.env.BILLING_AUTH = {
      describeAccount:async ({ accountId }) => ({ valid:true,role:accountId === "owner" ? "owner" : "member" }),
      listLinkTargets:async () => ({ targets:[
        { accountId:"owner",role:"owner" },{ accountId:"chiharu",role:"member" },{ accountId:"machiko",role:"member" }
      ] })
    };
    const recovery = await crypto.subtle.generateKey({
      name:"RSA-OAEP",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"
    },false,["encrypt","decrypt"]);
    const recoveryPublicKey = await crypto.subtle.exportKey("jwk",recovery.publicKey);
    f.env.SECURITY.getBillingRecoveryContext = async () => ({ publicKey:recoveryPublicKey,envelope:{} });
    seedLedger(f);
    Object.assign(f.env,{ BILLING_KEY_PREPARATION_ENABLED:"true", BILLING_MIGRATION_ENABLED:"true", BILLING_CUTOVER_ENABLED:"true" });
    const backupEnv = { BILLING_DB:f.env.DB,BACKUP:new Bucket() };
    f.env.BILLING_BACKUP = {
      writeCheckpoint: generation => billingCheckpoint(backupEnv,generation,true),
      readCheckpoint: generation => billingCheckpoint(backupEnv,generation)
    };
    const owner = await f.login("owner","primary-admin","fixture-primary-billing","YmlsbGluZy1vd25lcg");
    const member = await f.login("chiharu");
    const legacy = await f.request("summary?month=2026-10&accountId=chiharu",owner.cookie);
    let loseCommit = true, retried;
    function transport(cookie) {
      return async (path,options) => {
        const result = await f.request(path.slice(1),cookie,options);
        if (result.status >= 400) throw Object.assign(new Error(result.body.error),{ status:result.status });
        if (path === "/encryption/commit" && loseCommit) {
          loseCommit = false;
          retried = options.body;
          throw new TypeError("synthetic lost response");
        }
        return result.body;
      };
    }
    const ownerApi = transport(owner.cookie), memberApi = transport(member.cookie);
    const ownerAuth = { credentialId:"YmlsbGluZy1vd25lcg",prfOutput:ownerPRF };
    const ownerKeys = await prepareBillingVault(ownerApi,ownerAuth);
    const memberKeys = await prepareBillingVault(memberApi,{ credentialId:"Y3JlZGVudGlhbA",prfOutput:memberPRF });
    const start = { method:"POST",body:{ proof:"invalid",generation:crypto.randomUUID() } };
    await assert.rejects(ownerApi("/encryption/migration/start",start),error => error.status === 403);
    await assert.rejects(memberApi("/encryption/migration/challenge"),error => error.status === 403);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM billing_encryption_migration").get().n,0);
    const wasmBinary = readFileSync(new URL("../../security-worker/public/vendor/sql-wasm.wasm",import.meta.url));
    const progress = [];
    const result = await stageBillingMigration(ownerApi,ownerKeys,ownerAuth,(done,total)=>progress.push([done,total]),{
      unlockRecovery:async () => recovery.privateKey,
      restore:receipt => restoreBillingCheckpoint(receipt,{ wasmBinary }),
      activate:true
    });
    assert.equal(result.activated,true);
    assert.deepEqual(progress.at(-1),[7,7]);
    const persisted = await billingCheckpoint(backupEnv,result.migration);
    assert.match(persisted.archiveSha256,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(persisted),/Fixture owner|2026-10|amount_yen/);
    await assert.rejects(ownerApi("/summary?month=2026-10&accountId=chiharu"),error => error.status === 409);
    const memberApp = encryptedBillingApp(memberApi,member.body,memberKeys);
    const ownerApp = encryptedBillingApp(ownerApi,owner.body,ownerKeys);
    const path = "/summary?month=2026-10&accountId=chiharu";
    assert.deepEqual(await ownerApp.request(path),legacy.body);
    assert.deepEqual(await memberApp.request(path),legacy.body);
    await assert.rejects(memberApp.request("/summary?month=2026-10&accountId=machiko"),error => error.status === 403);
    const auditLedgerId = (await ownerApi("/encryption/ledgers")).ledgers.find(item=>item.accountId===null).ledgerId;
    await assert.rejects(memberApi(`/encryption/ledger?ledger=${auditLedgerId}`),error => error.status === 403);
    const body = { accountId:"chiharu",documentType:"invoice",entryDate:"2026-10-09",category:"purchase",amountYen:313,description:"encrypted fixture memo" };
    const created = await ownerApp.request("/entries",{ method:"POST",body },"chiharu");
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM billing_encryption_operations").get().n,1);
    assert.doesNotMatch(JSON.stringify(retried),/encrypted fixture memo|2026-10-09|amountYen/);
    assert.equal((await memberApp.request(path)).closingBalanceYen,legacy.body.closingBalanceYen+313);
    await ownerApp.request(`/entries/${created.id}`,{ method:"PUT",body:{ ...body, accountId:"machiko",amountYen:330 } },"chiharu");
    assert.equal((await memberApp.request(path)).closingBalanceYen,legacy.body.closingBalanceYen);
    const another = "/summary?month=2026-10&accountId=machiko";
    assert.equal((await ownerApp.request(another)).entries.find(entry=>entry.id===created.id).amountYen,330);
    await ownerApp.request(`/entries/${created.id}`,{ method:"DELETE",body:{} },"machiko");
    assert.equal((await ownerApp.request(another)).entries.some(entry=>entry.id===created.id),false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM billing_encryption_operations").get().n,3);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM billing_audit_logs WHERE event_type LIKE 'entry_%' AND details_json='{}'").get().n,3);
    const backup = await saveExport(exportEnv("billing",f.env.DB,backupEnv.BACKUP),"billing",Date.now(),{
      fetcher:exportFetcher(f.db,"billing",{ migration:BILLING_ENCRYPTED_MIGRATION }).fetcher
    });
    const manifest = await readExportManifest(backupEnv.BACKUP,backup.daily,"billing");
    assert.equal(manifest.payload.expectedMigration,BILLING_ENCRYPTED_MIGRATION);
    assert.equal(Object.hasOwn(manifest.payload.tables,"billing_entries"),false);
    assert.equal(manifest.payload.tables.billing_audit_logs.columns.includes("details_json"),false);
    const restored = await restoreIsolated(backupEnv.BACKUP,backup.daily,"billing");
    try {
      assert.equal(restored.db.prepare("SELECT count(*) AS n FROM billing_entries").get().n,0);
      assert.equal(restored.db.prepare("SELECT count(*) AS n FROM billing_encryption_live_ledgers").get().n,7);
    } finally { restored.db.close(); }
    f.securityDb.exec("UPDATE security_service_links SET status='disabled' WHERE id='link-chiharu'");
    await assert.rejects(memberApp.request(path),error => error.status === 401);
  } finally {
    ownerPRF.fill(0);
    memberPRF.fill(0);
    f.close();
  }
});
