const PRIMARY = 'primary-admin';
const ACCOUNT = 'nobumi';
const b64 = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v) && v.length % 4 !== 1;
function fail(ErrorType, status, message) { throw new ErrorType(status, message); }
export async function healthMember(db, identityId) { return Boolean(await db.prepare('SELECT 1 AS ok FROM security_health_members WHERE identity_id=?').bind(identityId).first()); }
export function healthMembershipStatement(db, identityId) {
  return db.prepare("INSERT OR IGNORE INTO security_health_members (slot,identity_id) VALUES (?,?)").bind(identityId === PRIMARY ? 'owner' : 'subject', identityId);
}
export async function assertHealthMemberAvailable(db, identityId, ErrorType) {
  const subject = await db.prepare("SELECT identity_id FROM security_health_members WHERE slot='subject'").first();
  if (identityId !== PRIMARY && subject && subject.identity_id !== identityId) fail(ErrorType, 403, '体調管理はオーナーと登録済みの本人だけが利用できます。');
}
export async function healthKeyBundle(env, input) {
  const row = await env.DB.prepare(`SELECT v.public_key_json, v.iv, v.ciphertext, g.wrapped_key
    FROM security_health_vaults v
    JOIN security_health_grants g ON g.credential_id=v.credential_id AND g.identity_id=v.identity_id
    JOIN security_service_links l ON l.id=g.service_link_id AND l.identity_id=v.identity_id
    JOIN security_credentials c ON c.credential_id=v.credential_id AND c.identity_id=v.identity_id
    JOIN security_identities i ON i.id=v.identity_id
    JOIN security_health_members m ON m.identity_id=i.id
    JOIN security_health_config cfg ON cfg.account_id='nobumi'
    WHERE v.identity_id=? AND v.credential_id=? AND l.id=? AND l.service='health' AND l.service_account_id='nobumi'
      AND l.status='active' AND c.status='active' AND i.status='active'`)
    .bind(input.identityId, input.credentialId, input.serviceLinkId).first();
  return row ? { vault: { publicKey: JSON.parse(row.public_key_json), iv: row.iv, ciphertext: row.ciphertext }, wrappedKey: row.wrapped_key } : null;
}
export async function handleHealthKeys(path, request, env, actor, helpers) {
  const { HttpError, readJson, json, audit } = helpers;
  const admin = actor.identityId === PRIMARY;
  if (!await healthMember(env.DB, actor.identityId)) fail(HttpError, 403, '体調管理への連携を先に追加してください。');
  const ownLink = await env.DB.prepare("SELECT id FROM security_service_links WHERE identity_id=? AND service='health' AND service_account_id=? AND status='active'").bind(actor.identityId, ACCOUNT).first();
  if (!ownLink) fail(HttpError, 403, '体調管理への連携を先に追加してください。');
  if (path === '/api/health/own' && request.method === 'GET') {
    const vault = await env.DB.prepare('SELECT iv,ciphertext,public_key_json FROM security_health_vaults WHERE identity_id=? AND credential_id=?').bind(actor.identityId, actor.credentialId).first();
    return json({ prepared: Boolean(vault), ready: Boolean(await healthKeyBundle(env, { ...actor, serviceLinkId: ownLink.id })) });
  }
  if (path === '/api/health/vault' && request.method === 'POST') {
    if (Date.now() / 1000 - actor.authenticatedAt > 300) fail(HttpError, 401, 'もう一度パスキーで本人確認してください。');
    const v = await readJson(request, 15000);
    if (Object.keys(v).sort().join(',') !== 'ciphertext,iv,publicKey' || !b64(v.iv, 16, 16) || !b64(v.ciphertext, 1000, 12000)
      || v.publicKey?.kty !== 'RSA' || !b64(v.publicKey.n, 512, 512) || v.publicKey.e !== 'AQAB' || v.publicKey.d) fail(HttpError, 400, '暗号化した利用者鍵を確認してください。');
    const publicKey = { kty: 'RSA', n: v.publicKey.n, e: 'AQAB', alg: 'RSA-OAEP-256', key_ops: ['encrypt'], ext: true };
    await env.DB.prepare('INSERT OR IGNORE INTO security_health_vaults (credential_id,identity_id,public_key_json,iv,ciphertext) VALUES (?,?,?,?,?)').bind(actor.credentialId, actor.identityId, JSON.stringify(publicKey), v.iv, v.ciphertext).run();
    const stored = await env.DB.prepare('SELECT * FROM security_health_vaults WHERE credential_id=?').bind(actor.credentialId).first();
    if (stored.identity_id !== actor.identityId || stored.public_key_json !== JSON.stringify(publicKey) || stored.iv !== v.iv || stored.ciphertext !== v.ciphertext) fail(HttpError, 409, '登録済みの暗号鍵は置き換えられません。');
    await audit('health_vault_prepared', actor.identityId);
    return json({ ok: true });
  }
  if (!admin) fail(HttpError, 403, '鍵の管理はオーナーが行います。');
  if (Date.now() / 1000 - actor.authenticatedAt > 300) fail(HttpError, 428, '鍵の管理前に管理者パスキーで再認証してください。');
  if (path === '/api/health/admin' && request.method === 'GET') {
    const config = await env.DB.prepare("SELECT recovery_wrapped_key AS recoveryWrappedKey, recovery_public_key AS recoveryPublicKey FROM security_health_config WHERE account_id='nobumi'").first();
    const cloudConfig = await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    const envelope = await env.DB.prepare("SELECT encrypted_payload AS encryptedPayload,payload_iv AS payloadIv FROM security_tcloud_key_envelopes WHERE identity_id='primary-admin' AND credential_id=? AND envelope_type='admin_private_prf'").bind(actor.credentialId).first();
    const members = (await env.DB.prepare(`SELECT v.identity_id AS identityId,v.credential_id AS credentialId,v.public_key_json AS publicKeyJson,l.id AS serviceLinkId,i.display_name AS displayName,
        EXISTS(SELECT 1 FROM security_health_grants g WHERE g.credential_id=v.credential_id AND g.service_link_id=l.id) AS granted
      FROM security_health_vaults v JOIN security_health_members m ON m.identity_id=v.identity_id
      JOIN security_service_links l ON l.identity_id=v.identity_id AND l.service='health' AND l.service_account_id='nobumi' AND l.status='active'
      JOIN security_credentials c ON c.credential_id=v.credential_id AND c.status='active'
      JOIN security_identities i ON i.id=v.identity_id AND i.status='active'`).all()).results;
    return json({ config, recoveryPublicKey: cloudConfig?.publicKeyJwk || null, adminEnvelope: envelope, members: members.map(m => ({ ...m, publicKey: JSON.parse(m.publicKeyJson), publicKeyJson: undefined })) });
  }
  if (path === '/api/health/initialize' && request.method === 'POST') {
    const v = await readJson(request, 3000);
    if (Object.keys(v).sort().join(',') !== 'recoveryWrappedKey' || !b64(v.recoveryWrappedKey, 512, 512)) fail(HttpError, 400, '暗号化した復旧用鍵を確認してください。');
    const config = await env.CLOUD_AUTH.getPrimaryAdminCryptoConfig();
    if (!config?.initialized || !config.publicKeyJwk) fail(HttpError, 409, 'T-Cloudの管理者鍵を先に準備してください。');
    const existing = await env.DB.prepare("SELECT recovery_wrapped_key FROM security_health_config WHERE account_id='nobumi'").first();
    if (existing && existing.recovery_wrapped_key !== v.recoveryWrappedKey) fail(HttpError, 409, '記録用の鍵は既に初期化されています。再読み込みしてください。');
    await env.DB.prepare("INSERT OR IGNORE INTO security_health_config (account_id,recovery_wrapped_key,recovery_public_key) VALUES ('nobumi',?,?)").bind(v.recoveryWrappedKey, JSON.stringify(config.publicKeyJwk)).run();
    const saved = await env.DB.prepare("SELECT recovery_wrapped_key FROM security_health_config WHERE account_id='nobumi'").first();
    if (saved.recovery_wrapped_key !== v.recoveryWrappedKey) fail(HttpError, 409, '別の操作で初期化されました。再読み込みしてください。');
    await audit('health_key_initialized', actor.identityId);
    return json({ ok: true });
  }
  if (path === '/api/health/grant' && request.method === 'POST') {
    const v = await readJson(request, 7000);
    if (Object.keys(v).sort().join(',') !== 'credentialId,serviceLinkId,wrappedKey' || !b64(v.wrappedKey, 512, 512)) fail(HttpError, 400, '暗号化した委譲鍵を確認してください。');
    const target = await env.DB.prepare(`SELECT l.identity_id FROM security_service_links l
      JOIN security_health_members m ON m.identity_id=l.identity_id
      JOIN security_health_vaults v ON v.identity_id=l.identity_id AND v.credential_id=?
      JOIN security_credentials c ON c.credential_id=v.credential_id AND c.identity_id=v.identity_id
      JOIN security_identities i ON i.id=l.identity_id
      JOIN security_health_config cfg ON cfg.account_id='nobumi'
      WHERE l.id=? AND l.service='health' AND l.service_account_id='nobumi' AND l.status='active' AND c.status='active' AND i.status='active'`).bind(v.credentialId, v.serviceLinkId).first();
    if (!target) fail(HttpError, 403, '承認対象の利用者鍵を確認できません。');
    await env.DB.prepare('INSERT OR IGNORE INTO security_health_grants (identity_id,credential_id,service_link_id,wrapped_key) VALUES (?,?,?,?)').bind(target.identity_id, v.credentialId, v.serviceLinkId, v.wrappedKey).run();
    const saved = await env.DB.prepare('SELECT wrapped_key FROM security_health_grants WHERE credential_id=? AND service_link_id=?').bind(v.credentialId, v.serviceLinkId).first();
    if (saved.wrapped_key !== v.wrappedKey) fail(HttpError, 409, '既に承認済みの鍵は置き換えられません。');
    await audit('health_key_granted', target.identity_id);
    return json({ ok: true });
  }
  fail(HttpError, 404, '指定された操作が見つかりません。');
}
