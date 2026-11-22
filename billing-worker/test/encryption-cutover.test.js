import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { capture } from "../../backup-worker/src/backup.js";
import { compress, verifiedPut } from "../../backup-worker/src/integrity.js";
import {
  planBillingLegacy, readBillingLegacyArchive, readBillingLegacySource,
  saveBillingLegacyVerification, verifyBillingLegacyCoverage, writeBillingLegacyArchive
} from "../../backup-worker/src/billing-legacy.js";
import { billingCheckpoint } from "../../backup-worker/src/billing-checkpoint.js";
import { BILLING_ENCRYPTED_MIGRATION } from "../../backup-worker/src/billing-encrypted.js";
import { readExportManifest, saveExport } from "../../backup-worker/src/export-backup.js";
import { Bucket } from "../../backup-worker/test/fixtures.mjs";
import { exportEnv, exportFetcher } from "../../backup-worker/test/export-fixtures.mjs";
import { restoreIsolated } from "../../backup-worker/tools/restore-isolated.mjs";
import { encryptedBillingApp, refreshBillingGrants } from "../public/billing-encrypted-app.mjs";
import { prepareBillingVault } from "../public/billing-key-client.mjs";
import { stageBillingMigration } from "../public/billing-migration-client.mjs";
import { prepareBillingLegacyMaintenance, restoreBillingCheckpoint } from "../public/billing-checkpoint-restore.mjs";
import { fixture, seedLedger } from "./performance-fixture.mjs";

test("ordinary admin login stages, restores and opens encrypted Billing; normal mutations preserve members and audit", async () => {
  const f = fixture();
  const ownerPRF = crypto.getRandomValues(new Uint8Array(32)), memberPRF = crypto.getRandomValues(new Uint8Array(32));
  const lateMemberPRF = crypto.getRandomValues(new Uint8Array(32));
  try {
    f.securityDb.exec(readFileSync(new URL("../../security-worker/e2ee/billing-vaults.sql",import.meta.url),"utf8"));
    f.securityDb.exec(`INSERT INTO security_identities (id,display_name,status,is_security_admin)
        VALUES ('primary-admin','Fixture admin','active',1);
      INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,prf_enabled,status)
        VALUES ('YmlsbGluZy1vd25lcg','primary-admin','AQI','AQI',1,'active');
      UPDATE security_credentials SET prf_enabled=1 WHERE credential_id='Y3JlZGVudGlhbA';
      UPDATE security_service_links SET status='disabled' WHERE id IN ('link-owner','link-machiko');
      INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status)
        VALUES ('fixture-primary-billing','primary-admin','billing','owner','Fixture','active');
      INSERT INTO security_identities (id,display_name,status) VALUES ('late-member','Late member','active');
      INSERT INTO security_credentials (credential_id,identity_id,public_key,prf_salt,prf_enabled,status)
        VALUES ('bGF0ZS1tZW1iZXI','late-member','AQI','AQI',1,'active');
      INSERT INTO security_service_links (id,identity_id,service,service_account_id,display_label,status)
        VALUES ('late-billing','late-member','billing','machiko','Late member','active');`);
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
    globalThis.TRoomCrypto = { unlockAdminPrivateKeyWithPasskey: async () => recovery.privateKey };
    seedLedger(f);
    f.db.exec(`INSERT INTO billing_opening_balances VALUES ('chiharu','2026-08-01',225,'owner',CURRENT_TIMESTAMP);
      INSERT INTO billing_audit_logs(event_type,actor_account_id,target_account_id,entry_id,details_json)
      VALUES ('entry_created','owner','chiharu',1,'{"memo":"fixture"}');`);
    const backupEnv = { BILLING_DB:f.env.DB,BACKUP:new Bucket() };
    const oldDay = Date.parse("2026-11-01T00:00:00Z");
    const snapshot = await capture(f.env.DB, "billing", oldDay);
    await backupEnv.BACKUP.put("d1/billing/daily/2026-11-01.json.gz", await compress({ ...snapshot, formatVersion:1 }));
    await verifiedPut(backupEnv.BACKUP,"d1/billing/v2/daily/2026-11-01.json.gz",await compress(snapshot));
    await saveExport(exportEnv("billing",f.env.DB,backupEnv.BACKUP),"billing",oldDay,{
      fetcher:exportFetcher(f.db,"billing").fetcher
    });
    f.db.exec(readFileSync(new URL("../encryption/migration-preparation.sql",import.meta.url),"utf8"));
    Object.assign(f.env,{ BILLING_KEY_PREPARATION_ENABLED:"true", BILLING_MIGRATION_ENABLED:"true", BILLING_CUTOVER_ENABLED:"true", BILLING_LEGACY_MIN_GENERATIONS:"4" });
    const bucket = backupEnv.BACKUP;
    f.env.BILLING_BACKUP = {
      writeCheckpoint: generation => billingCheckpoint(backupEnv,generation,true),
      readCheckpoint: generation => billingCheckpoint(backupEnv,generation),
      planLegacy: fingerprint => planBillingLegacy(bucket,fingerprint),
      readLegacySource: (...args) => readBillingLegacySource(bucket,...args),
      readLegacyArchive: id => readBillingLegacyArchive(bucket,id),
      writeLegacyArchive: archive => writeBillingLegacyArchive(bucket,archive),
      verifyLegacyCoverage: (...args) => verifyBillingLegacyCoverage(bucket,...args),
      saveLegacyVerification: (...args) => saveBillingLegacyVerification(bucket,...args)
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
    const path = "/summary?month=2026-10&accountId=chiharu";
    const startupCalls = [];
    const recordOwnerApi = async (path,options) => {
      startupCalls.push(path);
      return ownerApi(path,options);
    };
    const startup = await recordOwnerApi("/encryption/startup");
    assert.equal(startup.status.mode,"encrypted");
    const existingKeys = await prepareBillingVault(recordOwnerApi,ownerAuth,startup.vaultContext);
    const ownerApp = encryptedBillingApp(recordOwnerApi,owner.body,existingKeys,startup);
    assert.deepEqual((await ownerApp.request("/accounts?includeSummary=1&month=2026-10")).summary,legacy.body);
    assert.deepEqual(startupCalls.splice(0),["/encryption/startup"]);
    const memberApp = encryptedBillingApp(memberApi,member.body,memberKeys);
    assert.deepEqual(await ownerApp.request(path),legacy.body);
    assert.deepEqual(startupCalls.splice(0),["/encryption/view?accountId=chiharu"]);
    assert.deepEqual(await memberApp.request(path),legacy.body);
    await assert.rejects(memberApi("/encryption/pending-grants"),error => error.status === 403);
    await refreshBillingGrants(recordOwnerApi,ownerAuth);
    assert.deepEqual(startupCalls.splice(0),["/encryption/pending-grants"],"prepared recipients cause no recovery or grant writes");

    const lateMember = await f.login("machiko","late-member","late-billing","bGF0ZS1tZW1iZXI");
    const lateApi = transport(lateMember.cookie);
    const lateAuth = { credentialId:"bGF0ZS1tZW1iZXI",prfOutput:lateMemberPRF };
    const lateStartup = await lateApi("/encryption/startup");
    assert.deepEqual(lateStartup.accounts.map(account=>account.id),["machiko"]);
    assert.equal(lateStartup.view.ledger,null,"a member without a grant receives no encrypted ledger");
    const lateKeys = await prepareBillingVault(lateApi,lateAuth,lateStartup.vaultContext);
    const lateApp = encryptedBillingApp(lateApi,lateMember.body,lateKeys,lateStartup);
    await assert.rejects(lateApp.request("/accounts?includeSummary=1&month=2026-10"),/暗号鍵の配布を待っています/);
    await refreshBillingGrants(recordOwnerApi,ownerAuth);
    assert.deepEqual(startupCalls.splice(0),["/encryption/pending-grants","/encryption/recovery-context","/encryption/grants"]);
    assert.equal((await lateApp.request("/summary?month=2026-10")).account.id,"machiko");
    await refreshBillingGrants(recordOwnerApi,ownerAuth);
    assert.deepEqual(startupCalls.splice(0),["/encryption/pending-grants"]);
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
    const legacyPath = "/encryption/legacy";
    await assert.rejects(memberApi(`${legacyPath}/status`),error => error.status === 403);
    await assert.rejects(ownerApi(`${legacyPath}/plan`),error => error.status === 403);
    let cleanup;
    const maintenance = await prepareBillingLegacyMaintenance((path, options) => {
      if (path.endsWith("/cleanup")) cleanup = options;
      return ownerApi(path, options);
    },ownerKeys,ownerAuth,{ unlockRecovery:async () => recovery.privateKey, sqlite:{ wasmBinary } });
    await assert.rejects(maintenance.cleanup("平文原本を整理"), /復元を先に確認/);
    const before = await maintenance.status();
    assert.deepEqual(before, { entries:120, settlements:60, openingBalances:1, auditDetails:1, cleanedAt:null });
    const oldKey = "d1/billing/daily/2026-11-01.json.gz";
    const oldObject = bucket.objects.get(oldKey);
    bucket.objects.delete(oldKey);
    await assert.rejects(maintenance.verify(() => {}),error => error.status === 409);
    bucket.objects.set(oldKey,oldObject);
    const progressLegacy = [];
    assert.deepEqual(await maintenance.verify((...value) => progressLegacy.push(value)),{ generations:4, unreferencedParts:0 });
    assert.deepEqual(progressLegacy.at(-1),[4,4]);
    const sealedKeys = () => bucket.writes.filter(key => /^sealed\/billing-legacy\/v1\/[^/]+\.json$/.test(key));
    assert.equal(sealedKeys().length,3);
    assert.deepEqual(await maintenance.verify(() => {}),{ generations:4, unreferencedParts:0 });
    assert.equal(sealedKeys().length,3);
    await assert.rejects(maintenance.cleanup("間違った確認"),error => error.status === 400);
    const damaged = { ...cleanup, body:{ ...cleanup.body, report:{ ...cleanup.body.report, signature:"A".repeat(86) } } };
    await assert.rejects(ownerApi(`${legacyPath}/cleanup`,damaged),error => error.status === 409);
    const checkpointKey = `d1/billing/encrypted/checkpoints/${result.migration}.json.gz`;
    const sourceKey = sealedKeys()[0];
    const savedArchive = bucket.objects.get(sourceKey);
    bucket.objects.delete(sourceKey);
    await assert.rejects(maintenance.cleanup("平文原本を整理"));
    assert.deepEqual(await maintenance.status(),before);
    bucket.objects.set(sourceKey,savedArchive);
    await bucket.put(oldKey,oldObject.bytes);
    await assert.rejects(maintenance.cleanup("平文原本を整理"));
    bucket.objects.set(oldKey,oldObject);
    const checkpointObject = bucket.objects.get(checkpointKey);
    assert.ok(checkpointObject);
    bucket.objects.delete(checkpointKey);
    await assert.rejects(maintenance.cleanup("平文原本を整理"));
    assert.deepEqual(await maintenance.status(),before);
    bucket.objects.set(checkpointKey,checkpointObject);
    const cleaned = await maintenance.cleanup("平文原本を整理");
    assert.ok(cleaned.cleanedAt);
    assert.deepEqual(cleaned,{ entries:0, settlements:0, openingBalances:0, auditDetails:0, cleanedAt:cleaned.cleanedAt });
    assert.deepEqual(await maintenance.cleanup("平文原本を整理"),cleaned);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM billing_audit_logs WHERE event_type='encrypted_legacy_source_cleaned'").get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM billing_audit_logs WHERE event_type='entry_created'").get().n,2);
    assert.equal(bucket.objects.get(oldKey),oldObject);
    assert.deepEqual(await memberApp.request(path),legacy.body);
    assert.throws(() => f.db.exec("UPDATE billing_audit_logs SET details_json='x' WHERE id=1"),/billing migration in progress/);
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
    delete globalThis.TRoomCrypto;
    ownerPRF.fill(0);
    memberPRF.fill(0);
    lateMemberPRF.fill(0);
    f.close();
  }
});
