import { encode } from "../../diary-worker/e2ee/crypto.mjs";
import { createLegacyArchive } from "../tools/d1-legacy-archive.mjs";
import { listObjects } from "./backup.js";
import { billingLegacyProfile as profile } from "./billing-legacy-profile.js";
import { digest, hashObject } from "./integrity.js";

const storage = createLegacyArchive(profile);
const batchIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const fingerprintPattern = /^[A-Za-z0-9_-]{43}$/;
const maxSourceBytes = 8 * 1024 * 1024;
const sourceKey = key => typeof key === "string" && (profile.generationKey.test(key) || profile.partKey.test(key));
const sealedKey = id => `${profile.destinationPrefix}${id}.json`;

export async function planBillingLegacy(bucket, recoveryFingerprint) {
  if (!fingerprintPattern.test(recoveryFingerprint)) throw new Error("BillingArchiveRecoveryKeyInvalid");
  const objects = await listObjects(bucket, "d1/billing/");
  const inventory = objects.filter(({ key }) => sourceKey(key)).map(({ key, etag, size }) => ({ key, etag, size }));
  const { batches, unreferencedParts } = await storage.planArchives(bucket, inventory);
  const planned = await Promise.all(batches.map(async sources => {
    sources.sort((a, b) => a.key.localeCompare(b.key));
    const hash = await digest(encode([recoveryFingerprint, sources]));
    const id = hash.slice(0, 32).match(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/).slice(1).join("-");
    return { id, sources };
  }));
  return { batches: planned, generations: inventory.filter(({ key }) => profile.generationKey.test(key)).length,
    unreferencedParts: unreferencedParts.length };
}

export async function readBillingLegacySource(bucket, key, etag, size) {
  if (!sourceKey(key) || typeof etag !== "string" || !etag || etag.length > 128
    || !Number.isSafeInteger(size) || size < 1 || size > maxSourceBytes) throw new Error("BillingArchiveSourceInvalid");
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag } });
  if (!object?.body || object.etag !== etag || object.size !== size) throw new Error("BillingArchiveSourceChanged");
  return { body: object.body, etag, size, customMetadata: object.customMetadata ?? {} };
}

async function archiveReceipt(bucket, id) {
  if (!batchIdPattern.test(id)) throw new Error("BillingArchiveIdInvalid");
  const key = sealedKey(id);
  const head = await bucket.head(key);
  if (!head) return null;
  const { sha256, format } = head.customMetadata ?? {};
  if (!sha256Pattern.test(sha256) || format !== profile.format) throw new Error("BillingArchiveReadbackMismatch");
  return { id, key, sha256, etag: head.etag };
}

export async function readBillingLegacyArchive(bucket, id) {
  const receipt = await archiveReceipt(bucket, id);
  if (!receipt) return null;
  const archive = await storage.readArchive(bucket, receipt);
  return { archive, receipt };
}

export async function writeBillingLegacyArchive(bucket, archive) {
  try {
    await storage.publishArchive(bucket, archive);
  } catch (error) {
    if (error.message !== "BillingArchiveReadbackMismatch" || !await archiveReceipt(bucket, archive.id)) throw error;
    // Another approved session saved the same batch. The caller must fetch
    // and restore the winning archive before accepting its receipt.
  }
}

export async function verifyBillingLegacyCoverage(bucket, recoveryFingerprint, receipts) {
  const { batches, generations } = await planBillingLegacy(bucket, recoveryFingerprint);
  if (!Array.isArray(receipts) || receipts.length !== batches.length) throw new Error("BillingArchiveCoverageMismatch");
  if (receipts.some(receipt => !receipt || Object.keys(receipt).sort().join(",") !== "etag,id,sha256"
    || !batchIdPattern.test(receipt.id) || !sha256Pattern.test(receipt.sha256)
    || typeof receipt.etag !== "string" || !receipt.etag || receipt.etag.length > 128)) {
    throw new Error("BillingArchiveCoverageMismatch");
  }
  const expected = new Map(receipts.map(receipt => [receipt.id, receipt]));
  for (const { id } of batches) {
    const restored = expected.get(id);
    const stored = await archiveReceipt(bucket, id);
    if (!restored || !stored || stored.sha256 !== restored.sha256 || stored.etag !== restored.etag) {
      throw new Error("BillingArchiveCoverageMismatch");
    }
  }
  return generations;
}

export async function saveBillingLegacyVerification(bucket, generation, report, writer) {
  if (!batchIdPattern.test(generation)) throw new Error("BillingArchiveIdInvalid");
  const bytes = encode({ report, writer });
  const sha256 = await digest(bytes);
  const key = `${profile.destinationPrefix}receipts/${generation}/${sha256}.json`;
  await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" }, customMetadata: { sha256 } });
  const saved = await bucket.get(key);
  if (!saved?.body || saved.customMetadata?.sha256 !== sha256 || await hashObject(saved) !== sha256) {
    throw new Error("BillingArchiveReadbackMismatch");
  }
}
