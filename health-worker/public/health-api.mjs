export class RevisionConflict extends Error {}

export function createApi(state, onInvalidSession) {
  return async (path, options = {}, generation = state.auth.generation) => {
    state.check(generation);
    const response = await fetch(`/health/api${path}`, {
      credentials: 'same-origin', ...options,
      headers: { 'Content-Type': 'application/json',
        ...(state.auth.session ? { 'X-Health-Session': state.auth.session } : {}),
        ...options.headers },
    });
    const value = await response.json();
    state.check(generation);
    if (!response.ok) {
      const message = value.error || '処理を完了できませんでした。';
      if (response.status === 409 && value.code === 'revision_conflict') throw new RevisionConflict(message);
      if ([401, 403].includes(response.status) || response.status === 409 && value.code === 'session_changed') onInvalidSession(message);
      throw new Error(message);
    }
    return value;
  };
}
