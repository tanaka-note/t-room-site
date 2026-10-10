export class RevisionConflict extends Error {}

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
    if (!value) throw new Error(fallbackMessage(response.status));
    return value;
  };
}
