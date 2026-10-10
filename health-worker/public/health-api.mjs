export class RevisionConflict extends Error {}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const base64 = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && value.length % 4 !== 1 && /^[A-Za-z0-9_-]+$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 1;
export function validSuccess(path, method, value) {
  if (!object(value)) return false;
  if (path === '/records' && method === 'GET') return Array.isArray(value.records) && value.records.every(row =>
    object(row) && base64(row.id, 43, 43) && base64(row.iv, 16, 16) && base64(row.ciphertext, 22, 200000) && revision(row.revision));
  if (path.startsWith('/records/') && ['PUT', 'DELETE'].includes(method)) return value.ok === true && revision(value.revision);
  if (path === '/logout' && method === 'POST') return value.ok === true;
  if (path === '/passkey/handoff' && method === 'POST') {
    const bundle = value.keyBundle, vault = bundle?.vault, key = vault?.publicKey;
    return typeof value.sessionId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.sessionId)
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Math.floor(Date.now() / 1000)
      && object(bundle) && typeof bundle.accountId === 'string' && /^[a-z0-9_-]{1,128}$/.test(bundle.accountId)
      && object(vault) && base64(vault.iv, 16, 16) && base64(vault.ciphertext, 22, 200000)
      && object(key) && key.kty === 'RSA' && base64(key.n, 128, 8192) && base64(key.e, 2, 16)
      && base64(bundle.wrappedKey, 128, 8192);
  }
  return false;
}

function fallbackMessage(status) {
  if (status === 401) return 'もう一度パスキーでログインしてください。';
  if (status === 403) return 'アクセスを確認できませんでした。もう一度パスキーでログインしてください。';
  if (status === 409) return '記録の状態を確認できませんでした。最新の記録を読み込んでから再度お試しください。';
  if (status === 429) return 'アクセスが集中しています。少し待ってからお試しください。';
  if (status >= 500) return '一時的に利用できません。少し待ってからお試しください。';
  return 'サーバーの応答を確認できませんでした。再度お試しください。';
}

export function createApi(state, onInvalidSession) {
  return async (path, options = {}, generation = state.auth.generation) => {
    state.check(generation);
    const response = await fetch(`/health/api${path}`, {
      credentials: 'same-origin', ...options,
      headers: { 'Content-Type': 'application/json',
        ...(state.auth.session ? { 'X-Health-Session': state.auth.session } : {}),
        ...options.headers },
    });
    let value = null;
    if (/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) {
      try {
        const parsed = await response.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
      } catch { /* Infrastructure failures may have empty/truncated JSON bodies. */ }
    }
    state.check(generation);
    if (!response.ok) {
      const message = typeof value?.error === 'string' && value.error ? value.error : fallbackMessage(response.status);
      if (response.status === 409 && value?.code === 'revision_conflict') throw new RevisionConflict(message);
      if ([401, 403].includes(response.status) || response.status === 409 && value?.code === 'session_changed') onInvalidSession(message);
      throw new Error(message);
    }
    if (!validSuccess(path, (options.method || 'GET').toUpperCase(), value)) throw new Error(fallbackMessage(response.status));
    return value;
  };
}
