import { createBillingVault, unlockBillingVault } from "./billing-crypto.mjs";

export async function prepareBillingVault(api, authentication, initialContext) {
  const { credentialId, prfOutput } = authentication;
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error("請求書の暗号鍵を解除できるパスキーとブラウザをご利用ください。");
  }
  const path = "/encryption/vault";
  const context = initialContext ?? await api(path);
  if (context.credentialId !== credentialId || !context.supportsPrf) {
    throw new Error("ログインしたパスキーの暗号鍵を確認できません。");
  }
  let vault = context.vault;
  if (!vault || (context.primaryOwner && !vault.writer)) {
    const created = await createBillingVault(prfOutput, credentialId, { signing: context.primaryOwner });
    try {
      ({ vault } = await api(path, { method: "POST", body: { vault: created } }));
    } catch (error) {
      if (error.status && error.status < 500) throw error;
      // A response can be lost after the first write committed. Read the
      // authoritative envelope before deciding the enrollment failed.
      ({ vault } = await api(path));
      if (!vault || (context.primaryOwner && !vault.writer)) throw error;
    }
  }
  const keys = await unlockBillingVault(prfOutput, credentialId, vault);
  const cloud = context.cloudEnvelope && globalThis.TRoomCrypto
    ? await globalThis.TRoomCrypto.unlockPasskeyClientPrivateKey(prfOutput, context.cloudEnvelope).catch(() => null) : null;
  const writerPublicKey = vault.writer?.publicKey;
  return { ...keys,cloud,writerPublicKey,primaryOwner:context.primaryOwner,
    writerKeys:[...context.writerKeys,...(writerPublicKey ? [writerPublicKey] : [])] };
}
