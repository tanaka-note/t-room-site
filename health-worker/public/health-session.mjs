import { unlockClient, unwrapMaster } from './health-crypto.mjs';

async function discardFailedSession(sessionId) {
  let timeout;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 2000);
    // Lock has already erased the client state. Bind cleanup to the issued
    // session, without createApi's generation check or error/lock callbacks.
    await fetch('/health/api/logout', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Health-Session': sessionId },
      body: '{}', signal: controller.signal,
    });
  } catch { /* Cleanup must preserve the original login error and remain bounded. */ }
  finally { clearTimeout(timeout); }
}

export function createSession(state, api, load, lock) {
  let expiryTimer;
  async function signIn(generation) {
    const auth = await TRoomPasskeys.authenticate('health');
    let issuedSessionId = null;
    try {
      state.check(generation);
      if (!auth.prfOutput) throw new Error('この環境ではパスキーによる暗号鍵の解除を利用できません。平文での保存は行いません。');
      const result = await api('/passkey/handoff', { method: 'POST', body: JSON.stringify({ handoffToken: auth.handoff.handoffToken }) }, generation,
        sessionId => { issuedSessionId = sessionId; });
      issuedSessionId = result.sessionId;
      const key = await unlockClient(auth.prfOutput, result.keyBundle.vault);
      state.check(generation);
      const master = await unwrapMaster(key, result.keyBundle.wrappedKey, result.keyBundle.accountId);
      if (generation !== state.auth.generation) { master.fill(0); state.check(generation); }
      state.auth.master?.fill(0);
      state.auth.master = master;
      state.auth.accountId = result.keyBundle.accountId;
      state.auth.session = result.sessionId;
      await load(generation);
      state.check(generation);
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(lock, Math.max(0, result.expiresAt * 1000 - Date.now()));
    } catch (error) {
      if (generation === state.auth.generation) lock(error.message);
      auth.prfOutput?.fill(0);
      if (issuedSessionId) await discardFailedSession(issuedSessionId);
      throw error;
    } finally { auth.prfOutput?.fill(0); }
  }
  async function logout(generation) {
    try { await api('/logout', { method: 'POST', body: '{}' }, generation); }
    finally { if (generation === state.auth.generation) lock(); }
  }
  return { signIn, logout, clearExpiry: () => clearTimeout(expiryTimer) };
}
