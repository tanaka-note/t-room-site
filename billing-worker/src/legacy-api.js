import { fingerprint, verifySigned } from "../../diary-worker/e2ee/crypto.mjs";
import { billingLegacyPlaintextStatus, clearVerifiedBillingPlaintext } from "./legacy-cleanup.js";

import { legacyProtocol } from "../legacy-protocol.mjs";

export async function billingLegacyApi(request, env, url, path, state, actor, helpers) {
  const { json, readJson, HttpError } = helpers;
  const method = request.method;
  const store = env.BILLING_BACKUP;
  const fail = message => new HttpError(409, message);
  function checkGenerationCount(generations) {
    const minimum = Number(env.BILLING_LEGACY_MIN_GENERATIONS);
    if (!Number.isSafeInteger(minimum) || minimum < 1 || generations < minimum) {
      throw fail("棚卸し済みの旧バックアップが揃っていません。");
    }
  }
  if (!state?.activated_at || !state.verified_checkpoint || !store) throw fail("暗号化した台帳の切替と復元を確認できません。");
  if (path === "/status" && method === "GET") return json(await billingLegacyPlaintextStatus(env.DB));

  const recovery = await helpers.authorizeLegacy(path === "/challenge" && method === "GET");
  if (path === "/challenge" && method === "GET") return json(recovery);
  if (path === "/plan" && method === "GET") {
    const plan = await store.planLegacy(recovery.fingerprint);
    checkGenerationCount(plan.generations);
    return json({ ...plan, generation: state.generation, checkpoint: state.verified_checkpoint });
  }
  if (path === "/source" && method === "GET") {
    const { body, etag, size, customMetadata } = await store.readLegacySource(
      url.searchParams.get("key"), url.searchParams.get("etag"), Number(url.searchParams.get("size"))
    );
    return new Response(body, { headers: { "Cache-Control": "no-store", "Content-Type": "application/octet-stream",
      "X-Billing-Etag": etag, "X-Billing-Size": String(size), "X-Billing-Metadata": encodeURIComponent(JSON.stringify(customMetadata)) } });
  }
  if (path === "/archive" && method === "GET") return json(await store.readLegacyArchive(url.searchParams.get("id")));
  if (path === "/archive" && method === "POST") {
    const archive = await readJson(request, 23 * 1024 * 1024);
    if (archive.recipientFingerprint !== recovery.fingerprint) throw fail("復旧鍵が切り替わりました。パスキーでログインし直してください。");
    await store.writeLegacyArchive(archive);
    return json({ ok: true });
  }
  if (method === "POST" && (path === "/verified" || path === "/cleanup")) {
    const body = await readJson(request, 260000);
    const current = await billingLegacyRecovery(env, actor);
    if (current?.fingerprint !== recovery.fingerprint) throw fail("復旧鍵が切り替わりました。パスキーでログインし直してください。");
    const vault = await env.SECURITY.getBillingVaultContext(actor);
    if (!vault?.primaryOwner || !vault.vault?.writer) throw new HttpError(403, "署名用のパスキーを確認できません。");
    const approval = await verifySigned(body.report, vault.vault.writer.publicKey).catch(() => null);
    if (approval?.protocol !== legacyProtocol
      || Object.keys(approval).sort().join(",") !== "archives,checkpoint,generation,generations,protocol,recoveryFingerprint"
      || approval.generation !== state.generation
      || approval.checkpoint !== state.verified_checkpoint || approval.recoveryFingerprint !== recovery.fingerprint) {
      throw fail("復元結果の署名を照合できません。");
    }
    const generations = await store.verifyLegacyCoverage(recovery.fingerprint, approval.archives);
    checkGenerationCount(generations);
    if (generations !== approval.generations) throw fail("旧バックアップの復元世代数が一致しません。");
    if (path === "/verified") {
      await store.saveLegacyVerification(state.generation, { value: approval, signature: body.report.signature }, vault.vault.writer.publicKey);
      return json({ generations });
    }
    if (body.confirmation !== "平文原本を整理") throw new HttpError(400, "平文原本の整理を確認してください。");
    const checkpoint = await store.readCheckpoint(state.generation);
    if (checkpoint.archiveSha256 !== state.verified_checkpoint) throw fail("切替時の暗号化バックアップを照合できません。");
    await store.saveLegacyVerification(state.generation, { value: approval, signature: body.report.signature }, vault.vault.writer.publicKey);
    return json(await clearVerifiedBillingPlaintext(env.DB, state));
  }
  throw new HttpError(404, "バックアップ整理の操作が見つかりません。");
}

export async function billingLegacyRecovery(env, actor) {
  const context = await env.SECURITY.getBillingRecoveryContext(actor);
  return context ? { ...context, fingerprint: await fingerprint(context.publicKey) } : null;
}
