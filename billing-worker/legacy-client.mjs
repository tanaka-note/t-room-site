import { digest } from "../backup-worker/src/integrity.js";
import { b64, encode, fingerprint, signed, unb64 } from "../diary-worker/e2ee/crypto.mjs";
import { legacyProtocol } from "./legacy-protocol.mjs";
import { billingLegacyArchive } from "./restore-legacy.mjs";

const path = "/encryption/legacy";
const label = new TextEncoder().encode("T-lain Billing archive recovery challenge v1");

export async function prepareBillingLegacyMaintenance(api, keys, authentication, options = {}) {
  const context = await api(`${path}/challenge`);
  if (await fingerprint(context.publicKey) !== context.fingerprint) throw new Error("旧バックアップの復旧鍵を照合できません。");
  const unlock = options.unlockRecovery ?? globalThis.TRoomCrypto.unlockAdminPrivateKeyWithPasskey;
  const recoveryPrivateKey = await unlock(authentication.prfOutput, context.envelope);
  const proof = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP", label },
    recoveryPrivateKey, unb64(context.challenge, 684)));
  const headers = { "X-Billing-Recovery-Proof": b64(proof), "X-Billing-Recovery-Key": context.fingerprint };
  proof.fill(0);
  const fallbackSource = { async get(key, { onlyIf: { etagMatches } } = {}) {
    const query = new URLSearchParams({ key, etag: etagMatches, size: String(sizes.get(key)) });
    const response = await call(`/source?${query}`, { raw: true });
    return {
      body: response.body, etag: response.headers.get("X-Billing-Etag"),
      size: Number(response.headers.get("X-Billing-Size")),
      customMetadata: JSON.parse(decodeURIComponent(response.headers.get("X-Billing-Metadata")))
    };
  } };
  const sizes = new Map();
  const call = (endpoint, init = {}) => api(path + endpoint, { ...init, headers });
  const archiveTools = await billingLegacyArchive(options.sqlite);
  let report;
  return {
    status: () => call("/status"),
    async verify(progress) {
      report = null;
      const plan = await call("/plan");
      const archives = [];
      let generations = 0;
      for (const { id, sources } of plan.batches) {
        const query = new URLSearchParams({ id });
        const archivePath = `/archive?${query}`;
        let saved = await call(archivePath);
        let sourceReport;
        if (!saved) {
          for (const source of sources) sizes.set(source.key, source.size);
          const sealed = await archiveTools.sealArchive(fallbackSource, sources, {
            archiveId: id, recoveryPublicKey: context.publicKey, expectedRecoveryFingerprint: context.fingerprint
          });
          await call("/archive", { method: "POST", body: sealed.archive });
          sourceReport = sealed.sourceReport;
          saved = await call(archivePath);
        }
        if (!saved || saved.archive.id !== id || saved.receipt.id !== id
          || await digest(encode(saved.archive)) !== saved.receipt.sha256) {
          throw new Error("保存した暗号化バックアップを確認できません。");
        }
        const verified = await archiveTools.verifyArchive(saved.archive, {
          inventory: sources, sourceReport, recoveryPrivateKey, expectedRecoveryFingerprint: context.fingerprint
        });
        archives.push({ id, sha256: saved.receipt.sha256, etag: saved.receipt.etag });
        generations += verified.generations.length;
        progress(generations, plan.generations);
      }
      if (generations !== plan.generations) throw new Error("復元した旧バックアップの世代数が一致しません。");
      const result = await signed({ protocol: legacyProtocol, generation: plan.generation, checkpoint: plan.checkpoint,
        recoveryFingerprint: context.fingerprint, archives, generations }, keys.writer);
      await call("/verified", { method: "POST", body: { report: result } });
      report = result;
      return { generations, unreferencedParts: plan.unreferencedParts };
    },
    async cleanup(confirmation) {
      if (!report) throw new Error("旧バックアップの復元を先に確認してください。");
      return call("/cleanup", { method: "POST", body: { report, confirmation } });
    }
  };
}
