const ORIGIN = 'https://tanaka-note.com';
const PURPOSE = 'T-ROOM Cloud Storage Windows device authorization v1';
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = () => encode(crypto.getRandomValues(new Uint8Array(32)));
function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new DeviceError(400, 'invalid_proof');
  let bytes;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)); }
  catch { throw new DeviceError(400, 'invalid_proof'); }
  if (bytes.length !== length || encode(bytes) !== value) throw new DeviceError(400, 'invalid_proof');
  return bytes;
}
class DeviceError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
async function body(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new DeviceError(415, 'json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new DeviceError(400, 'invalid_request');
  const parts = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length;
      if (size > 8192) { await reader.cancel(); throw new DeviceError(413, 'request_too_large'); }
      parts.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value;
  } catch { throw new DeviceError(400, 'invalid_request'); }
}
export async function devicePublicKey(value) {
  if (!value || value.kty !== 'EC' || value.crv !== 'P-256' || Object.keys(value).some(key => !['kty','crv','x','y'].includes(key)))
    throw new DeviceError(400, 'invalid_public_key');
  decode(value.x, 32); decode(value.y, 32);
  const jwk = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y };
  try { await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  catch { throw new DeviceError(400, 'invalid_public_key'); }
  return jwk;
}
export function deviceChallengeMessage(challenge) {
  return encoder.encode([PURPOSE, `${ORIGIN}/cloud/`, challenge.deviceId, challenge.challengeId,
    challenge.nonce, challenge.scopeHash, String(challenge.expiresAt)].join('\n'));
}
function claims(binding) {
  return { service: 'cloud', identityId: binding.identityId, credentialId: binding.credentialId,
    serviceLinkId: binding.serviceLinkId, serviceAccountId: binding.serviceAccountId,
    cloudRootFolderId: binding.rootFolderId, sessionEpoch: binding.sessionEpoch,
    ...(binding.folderScopes ? { folderScopes: binding.folderScopes } : {}) };
}
async function currentAuthority(env, binding, deps) {
  if (String(env.PASSKEY_ENABLED || 'true') !== 'true' || binding.sessionVersion !== String(env.SESSION_VERSION || '1')) return null;
  const context = await env.SECURITY.cloudWindowsDeviceContext(claims(binding));
  if (!context?.valid) return null;
  const publicKey = binding.serviceAccountId === 'admin' ? await deps.adminPublicKey() : context.publicKeyJwk;
  if (!publicKey || publicKey.kty !== 'RSA' || typeof publicKey.n !== 'string' || typeof publicKey.e !== 'string') return null;
  const keyFingerprint = await digest(JSON.stringify({ kty: 'RSA', n: publicKey.n, e: publicKey.e }));
  return { ...context, keyFingerprint };
}
async function checkDevice(env, row, deps) {
  if (!row || row.status === 'revoked') throw new DeviceError(401, 'device_revoked');
  const binding = JSON.parse(row.binding_json);
  const authority = await currentAuthority(env, binding, deps);
  if (!authority || authority.authorityVersion !== binding.authorityVersion || authority.keyFingerprint !== binding.keyFingerprint) {
    await env.DB.prepare("UPDATE cloud_windows_devices SET status='revoked',revoked_at=? WHERE id=? AND status!='revoked'")
      .bind(now(), row.id).run();
    throw new DeviceError(401, 'device_revoked');
  }
  return { binding, authority };
}
async function webSession(request, deps) {
  const session = await deps.readWebSession(request);
  if (!session || session.authMethod !== 'passkey' || !['admin','member'].includes(session.role)) throw new DeviceError(401, 'initial_auth_required');
  deps.assertWebContext(request, session);
  const started = Date.parse(session.startedAt) / 1000;
  if (!Number.isFinite(started) || started > now() + 30 || started < now() - 300) throw new DeviceError(401, 'fresh_initial_auth_required');
  return session;
}
async function issueChallenge(env, row, purpose) {
  const value = { deviceId: row.id, challengeId: crypto.randomUUID().replace(/-/g,''), nonce: token(),
    scopeHash: row.scope_hash, expiresAt: now() + 120 };
  const created = await env.DB.prepare(`INSERT INTO cloud_windows_challenges(id,device_id,purpose,nonce_hash,expires_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM cloud_windows_challenges
    WHERE device_id=? AND consumed_at IS NULL AND expires_at>?)<8`)
    .bind(value.challengeId, row.id, purpose, await digest(value.nonce), value.expiresAt, row.id, now()).run();
  if (created.meta?.changes !== 1) throw new DeviceError(429, 'challenge_limit');
  return json(value);
}
async function proof(request, env, deps, purpose) {
  const input = await body(request);
  if (!id(input.deviceId) || !id(input.challengeId)) throw new DeviceError(400, 'invalid_proof');
  const row = await env.DB.prepare('SELECT * FROM cloud_windows_devices WHERE id=?').bind(input.deviceId).first();
  if (!row || row.status !== (purpose === 'enroll' ? 'pending' : 'active')) throw new DeviceError(401, 'device_revoked');
  if (purpose === 'enroll') {
    const session = await webSession(request, deps);
    if (await digest(session.sessionId) !== row.enrollment_session_hash || row.enrollment_expires_at <= now()) throw new DeviceError(401, 'initial_auth_required');
  }
  const challenge = await env.DB.prepare('SELECT * FROM cloud_windows_challenges WHERE id=? AND device_id=? AND purpose=?')
    .bind(input.challengeId, row.id, purpose).first();
  if (!challenge || challenge.consumed_at != null || challenge.expires_at <= now()) throw new DeviceError(401, 'proof_expired_or_used');
  const counted=await env.DB.prepare('UPDATE cloud_windows_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5 AND consumed_at IS NULL AND expires_at>?')
    .bind(challenge.id,now()).run();
  if(counted.meta?.changes!==1)throw new DeviceError(429,'proof_attempt_limit');
  try {
  decode(input.nonce, 32);
  if (await digest(input.nonce) !== challenge.nonce_hash) throw new DeviceError(401, 'invalid_proof');
  const signature = decode(input.signature, 64);
  const publicKey = await crypto.subtle.importKey('jwk', JSON.parse(row.public_key_json), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const message = deviceChallengeMessage({ deviceId: row.id, challengeId: challenge.id, nonce: input.nonce,
    scopeHash: row.scope_hash, expiresAt: challenge.expires_at });
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, message)) throw new DeviceError(401, 'invalid_proof');
  await checkDevice(env, row, deps);
  const attempt = crypto.randomUUID(); const accessToken = token(); const expiresAt = now() + 900;
  const statements = [env.DB.prepare(`UPDATE cloud_windows_challenges SET consumed_at=?,proof_id=?
    WHERE id=? AND consumed_at IS NULL AND expires_at>?`).bind(now(), attempt, challenge.id, now())];
  if (purpose === 'enroll') statements.push(env.DB.prepare(`UPDATE cloud_windows_devices SET status='active',activated_at=?
    WHERE id=? AND status='pending' AND enrollment_expires_at>? AND EXISTS
    (SELECT 1 FROM cloud_windows_challenges WHERE id=? AND proof_id=?)`).bind(now(), row.id, now(), challenge.id, attempt));
  statements.push(env.DB.prepare(`INSERT INTO cloud_windows_access(token_hash,device_id,expires_at)
    SELECT ?,id,? FROM cloud_windows_devices WHERE id=? AND status='active' AND EXISTS
    (SELECT 1 FROM cloud_windows_challenges WHERE id=? AND proof_id=?)`).bind(await digest(accessToken), expiresAt, row.id, challenge.id, attempt));
  statements.push(env.DB.prepare(`UPDATE cloud_windows_devices SET last_seen_at=? WHERE id=? AND status='active'
    AND EXISTS(SELECT 1 FROM cloud_windows_challenges WHERE id=? AND proof_id=?)`).bind(now(), row.id, challenge.id, attempt));
  const results = await env.DB.batch(statements);
  if (results.at(-2)?.meta?.changes !== 1) throw new DeviceError(401, 'proof_expired_or_used');
  await deps.audit(purpose === 'enroll' ? 'windows_device_registered' : 'windows_device_renewed', JSON.parse(row.binding_json), row.id);
  return json({ deviceId: row.id, scopeHash: row.scope_hash, accessToken, expiresAt });
  } catch(error) {
    await deps.audit('windows_device_proof_failure',JSON.parse(row.binding_json),row.id,'failure',{
      reason:error instanceof DeviceError?error.code:'authorization_unavailable'});
    throw error;
  }
}
async function access(request, env, deps) {
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new DeviceError(401, 'access_expired');
  const row = await env.DB.prepare(`SELECT d.* FROM cloud_windows_access a JOIN cloud_windows_devices d ON d.id=a.device_id
    WHERE a.token_hash=? AND a.expires_at>? AND d.status='active'`).bind(await digest(authorization.slice(7)), now()).first();
  if (!row) throw new DeviceError(401, 'access_expired');
  return { row, ...await checkDevice(env, row, deps) };
}
export function windowsDataRoute(path, method) {
  return method === 'GET' && (/^\/api\/(items|crypto-config)$/.test(path) || /^\/api\/files\/[1-9]\d*(\/download)?$/.test(path))
    || method === 'POST' && (/^\/api\/(uploads|folders)$/.test(path) || /^\/api\/uploads\/[1-9]\d*\/complete$/.test(path))
    || method === 'PUT' && /^\/api\/uploads\/[1-9]\d*\/parts\/[1-9]\d*$/.test(path)
    || method === 'PATCH' && /^\/api\/(files|folders)\/[1-9]\d*$/.test(path)
    || method === 'DELETE' && /^\/api\/uploads\/[1-9]\d*$/.test(path);
}
export async function handleWindowsSync(request, env, url, path, deps) {
  try {
    if (String(env.WINDOWS_SYNC_ENABLED || 'false') !== 'true') throw new DeviceError(503, 'windows_sync_unavailable');
    if (url.origin !== ORIGIN || request.headers.has('Origin') && request.headers.get('Origin') !== ORIGIN) throw new DeviceError(403, 'invalid_origin');
    const route = path.slice('/api/windows-sync'.length);
    if (route === '/enroll/challenge' && request.method === 'POST') {
      const session = await webSession(request, deps); const input = await body(request);
      const publicKey = await devicePublicKey(input.publicKeyJwk);
      const binding = { identityId: session.identityId, credentialId: session.credentialId,
        serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId,
        rootFolderId: session.rootFolderId, sessionEpoch: session.passkeySessionEpoch,
        sessionVersion: String(session.version), role: session.role, ...(session.folderScopes ? { folderScopes: session.folderScopes } : {}) };
      const authority = await currentAuthority(env, binding, deps);
      if (!authority) throw new DeviceError(401, 'initial_auth_required');
      binding.authorityVersion = authority.authorityVersion; binding.keyFingerprint = authority.keyFingerprint;
      const deviceId = crypto.randomUUID().replace(/-/g,'');
      const scopeHash = await digest(JSON.stringify({ binding, publicKey }));
      const row = { id: deviceId, scope_hash: scopeHash };
      await env.DB.prepare(`INSERT INTO cloud_windows_devices
        (id,status,public_key_json,binding_json,scope_hash,enrollment_session_hash,enrollment_expires_at,created_at)
        VALUES(?,'pending',?,?,?,?,?,?)`).bind(deviceId, JSON.stringify(publicKey), JSON.stringify(binding), scopeHash,
          await digest(session.sessionId), now()+300, now()).run();
      return await issueChallenge(env, row, 'enroll');
    }
    if (route === '/enroll/complete' && request.method === 'POST') return await proof(request, env, deps, 'enroll');
    if (route === '/challenge' && request.method === 'POST') {
      const input = await body(request);
      if (!id(input.deviceId)) throw new DeviceError(400, 'invalid_request');
      const row = await env.DB.prepare("SELECT * FROM cloud_windows_devices WHERE id=? AND status='active'").bind(input.deviceId).first();
      if (!row) throw new DeviceError(401, 'device_revoked');
      return await issueChallenge(env, row, 'renew');
    }
    if (route === '/token' && request.method === 'POST') return await proof(request, env, deps, 'renew');
    const auth = await access(request, env, deps);
    if (route === '/keys' && request.method === 'GET') return json({ scopeHash: auth.row.scope_hash,
      folderKeys: auth.authority.folderKeys, rootFolderId: auth.binding.rootFolderId, folderScopes: auth.binding.folderScopes || null });
    if (route === '/revoke' && request.method === 'POST') {
      await env.DB.prepare("UPDATE cloud_windows_devices SET status='revoked',revoked_at=? WHERE id=?").bind(now(),auth.row.id).run();
      await deps.audit('windows_device_revoked', auth.binding, auth.row.id); return json({ revoked: true });
    }
    if (route.startsWith('/data/')) {
      const dataPath = '/api/' + route.slice('/data/'.length);
      if (!windowsDataRoute(dataPath, request.method)) throw new DeviceError(403, 'operation_not_allowed');
      if (request.method === 'PATCH' && /^\/api\/folders\//.test(dataPath)) {
        const value=await body(request);
        if (value.passwordAction != null && value.passwordAction !== 'keep'
          || ['authProof','passwordSalt','passwordWrappedKey','passwordWrapIv'].some(key=>Object.hasOwn(value,key)))
          throw new DeviceError(403,'operation_not_allowed');
        request=new Request(request,{body:JSON.stringify(value)});
      }
      return await deps.dispatch(request, dataPath, auth.binding, auth.row.id);
    }
    throw new DeviceError(404, 'not_found');
  } catch (error) {
    if (!(error instanceof DeviceError) && Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)
      return json({ error: '同期対象への操作を実行できません。', code: 'data_request_rejected' }, error.status);
    return json({ error: error instanceof DeviceError ? error.code : '同期の認可を確認できません。',
      code: error instanceof DeviceError ? error.code : 'authorization_unavailable' }, error instanceof DeviceError ? error.status : 503);
  }
}

export async function cleanupWindowsSync(env) {
  if (String(env.WINDOWS_SYNC_ENABLED || 'false') !== 'true') return;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cloud_windows_challenges WHERE expires_at<?').bind(now()-86400),
    env.DB.prepare('DELETE FROM cloud_windows_access WHERE expires_at<?').bind(now()),
    env.DB.prepare("DELETE FROM cloud_windows_devices WHERE status='pending' AND enrollment_expires_at<?").bind(now()-86400)
  ]);
}
