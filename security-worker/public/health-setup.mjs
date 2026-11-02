import { createClientVault, wrapMaster, unwrapMaster } from '/security/health-crypto.mjs';
async function api(path, value) {
  const fallback = '処理結果を確認できませんでした。時間を置いてもう一度お試しください。';
  let r, v;
  try { r = await fetch(`/security/api${path}`, { credentials: 'same-origin', ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) }); }
  catch { throw new Error(fallback); }
  if (/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(r.headers.get('content-type') || '')) {
    try { v = await r.json(); } catch { /* Unconfirmed responses use the same safe message below. */ }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = null;
  if (!r.ok) throw new Error(typeof v?.error === 'string' && v.error.length > 0 && v.error.length <= 500 ? v.error : [401, 403].includes(r.status) ? 'もう一度パスキーで本人確認してください。' : fallback);
  if (!v) throw new Error(fallback);
  return v;
}
async function prepare(prf) {
  if (!prf) throw new Error('この環境では安全な鍵の解除を利用できません。対応するブラウザでお試しください。');
  const current = await api('/health/own');
  if (!current.prepared) await api('/health/vault', await createClientVault(prf));
}
export async function prepareHealth() {
  const auth = await TRoomPasskeys.authenticate('health', undefined, { handoff: false });
  try { await prepare(auth.prfOutput); return await api('/health/own'); }
  finally { auth.prfOutput?.fill(0); }
}

export async function loadHealthApprovals(identityId, serviceLinkId) {
  const auth = await TRoomPasskeys.authenticate('security'); let master;
  try {
    await prepare(auth.prfOutput);
    let status = await api('/health/admin');
    if (!status.adminEnvelope || !status.recoveryPublicKey) throw new Error('Security Centerで、この管理者パスキーのT-Cloud鍵準備・復旧を先に完了してください。');
    const privateKey = await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput, status.adminEnvelope);
    if (!status.config) {
      master = crypto.getRandomValues(new Uint8Array(32));
      await api('/health/initialize', { recoveryWrappedKey: await wrapMaster(master, status.recoveryPublicKey, status.accountId) });
      status = await api('/health/admin');
    } else master = await unwrapMaster(privateKey, status.config.recoveryWrappedKey, status.accountId);
    const approvals = [];
    for (const member of status.members.filter(member => member.identityId === identityId && member.serviceLinkId === serviceLinkId)) {
      const item = { credentialId: member.credentialId, granted: Boolean(member.granted) };
      if (!member.granted) {
        // Keep only the encrypted grant in the closure; plaintext master is wiped below.
        const wrappedKey = await wrapMaster(master, member.publicKey, status.accountId);
        item.approve = async () => {
          const fresh = await TRoomPasskeys.authenticate('security');
          try { await api('/health/grant', { credentialId: member.credentialId, serviceLinkId: member.serviceLinkId, wrappedKey }); }
          finally { fresh.prfOutput?.fill(0); }
        };
      }
      approvals.push(item);
    }
    return approvals;
  } finally { master?.fill(0); auth.prfOutput?.fill(0); }
}
