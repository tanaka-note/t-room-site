import { createClientVault, wrapMaster, unwrapMaster } from '/security/health-crypto.mjs';
const $ = id => document.getElementById(id);
async function api(path, value) {
  const r = await fetch(`/security/api${path}`, { credentials: 'same-origin', ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) });
  const v = await r.json(); if (!r.ok) throw new Error(v.error || '処理を完了できませんでした。'); return v;
}
async function run(task) {
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  $('status').textContent = '処理しています…';
  try { await task(); } catch (e) { $('status').textContent = e.message; }
  finally { document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
async function prepare(prf) {
  if (!prf) throw new Error('この環境では安全な鍵の解除を利用できません。対応するブラウザでお試しください。');
  const current = await api('/health/own');
  if (!current.prepared) await api('/health/vault', await createClientVault(prf));
}
$('prepare').onclick = () => run(async () => {
  const auth = await TRoomPasskeys.authenticate('health', undefined, { handoff: false });
  try { await prepare(auth.prfOutput); $('status').textContent = '利用者鍵を準備しました。オーナーの承認後、パスキーで体調管理を利用できます。'; }
  finally { auth.prfOutput?.fill(0); }
});
$('owner-link').onclick = () => run(async () => {
  const auth = await TRoomPasskeys.authenticate('security');
  try { await api('/identities/primary-admin/links', { links: [{ service: 'health', accountId: 'nobumi', rootFolderId: null }] }); $('status').textContent = 'オーナーの連携を追加しました。次に鍵の準備・承認を行ってください。'; }
  finally { auth.prfOutput?.fill(0); }
});
$('manage').onclick = () => run(async () => {
  const auth = await TRoomPasskeys.authenticate('security'); let master;
  try {
    await prepare(auth.prfOutput);
    let status = await api('/health/admin');
    if (!status.adminEnvelope || !status.recoveryPublicKey) throw new Error('Security Centerで、この管理者パスキーのT-Cloud鍵準備・復旧を先に完了してください。');
    const privateKey = await TRoomCrypto.unlockAdminPrivateKeyWithPasskey(auth.prfOutput, status.adminEnvelope);
    if (!status.config) {
      master = crypto.getRandomValues(new Uint8Array(32));
      await api('/health/initialize', { recoveryWrappedKey: await wrapMaster(master, status.recoveryPublicKey) });
      status = await api('/health/admin');
    } else master = await unwrapMaster(privateKey, status.config.recoveryWrappedKey);
    $('members').replaceChildren();
    for (const member of status.members) {
      const line = document.createElement('p');
      line.textContent = `${member.displayName}：${member.granted ? '承認済み' : '鍵の承認待ち'}`;
      if (!member.granted) {
        const button = document.createElement('button'); button.textContent = 'このパスキーの鍵を承認';
        // Keep only the encrypted grant in the closure; plaintext master is wiped below.
        const wrappedKey = await wrapMaster(master, member.publicKey);
        button.onclick = () => run(async () => {
          const fresh = await TRoomPasskeys.authenticate('security');
          try { await api('/health/grant', { credentialId: member.credentialId, serviceLinkId: member.serviceLinkId, wrappedKey }); line.replaceChildren(document.createTextNode(`${member.displayName}：承認済み`)); $('status').textContent = '鍵の利用を承認しました。'; }
          finally { fresh.prfOutput?.fill(0); }
        });
        line.append(' ', button);
      }
      $('members').append(line);
    }
    $('status').textContent = '鍵の状態を確認しました。承認待ちのパスキーを確認して承認してください。';
  } finally { master?.fill(0); auth.prfOutput?.fill(0); }
});
