(() => {
  "use strict";

  const API = "/security/api";

  async function authenticate(service, chooseLink) {
    ensureSupport();
    try {
      const start = await api("/auth/options", { service });
      const credential = await navigator.credentials.get({ publicKey: decodeRequestOptions(start.options) });
      const prfOutput = readPrfOutput(credential);
      const verified = await api("/auth/verify", { service, challengeId: start.challengeId, response: serializeCredential(credential) });
      const link = verified.links.length === 1 ? verified.links[0] : await chooseLink?.(verified.links);
      if (service !== "security" && !link) throw new Error("利用するアカウントを選択してください。");
      const handoff = service === "security" ? null : await api("/auth/handoff", { service, linkId: link.id });
      return { verified, link, handoff, credentialId: verified.credentialId, prfOutput };
    } catch (error) {
      if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
        api("/auth/cancelled", { service }).catch(() => {});
        throw new PasskeyCancelledError();
      }
      throw error;
    }
  }

  async function registerInvite(token) {
    ensureSupport();
    const start = await api("/invite/options", { token });
    const credential = await navigator.credentials.create({ publicKey: decodeCreationOptions(start.options) });
    const result = await api("/invite/verify", { token, challengeId: start.challengeId, response: serializeCredential(credential), prfEnabled: supportsPrf(credential) });
    const prf = await obtainPrfSafely(result.credentialId);
    return { ...result, ...prf, cloudLink: start.cloudLink };
  }

  async function bootstrap(authProof) {
    ensureSupport();
    const start = await api("/bootstrap/options", authProof);
    const credential = await navigator.credentials.create({ publicKey: decodeCreationOptions(start.options) });
    const result = await api("/bootstrap/verify", { challengeId: start.challengeId, response: serializeCredential(credential), prfEnabled: supportsPrf(credential) });
    const prf = await obtainPrfSafely(result.credentialId);
    return { ...result, ...prf };
  }

  async function obtainPrfSafely(credentialId) {
    try {
      return { ...(await obtainPrf(credentialId)), prfPreparationFailed: false };
    } catch (error) {
      return {
        prfOutput: null,
        prfAvailable: false,
        prfPreparationFailed: true,
        prfPreparationError: error instanceof Error ? error.message : "T-Cloudのパスキー復号準備を完了できませんでした。"
      };
    }
  }

  async function obtainPrf(credentialId) {
    const start = await api("/prf/options", { credentialId });
    const credential = await navigator.credentials.get({ publicKey: decodeRequestOptions(start.options) });
    const prfOutput = readPrfOutput(credential);
    await api("/prf/verify", { challengeId: start.challengeId, response: serializeCredential(credential), prfAvailable: Boolean(prfOutput) });
    return { prfOutput, prfAvailable: Boolean(prfOutput), prfSalt: start.prfSalt };
  }

  async function api(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "端末のロック解除を確認できませんでした。");
    return payload;
  }

  function decodeCreationOptions(options) {
    return {
      ...options,
      challenge: fromBase64Url(options.challenge),
      user: { ...options.user, id: fromBase64Url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map(decodeDescriptor)
    };
  }

  function decodeRequestOptions(options) {
    const extensions = options.extensions?.prf?.evalByCredential
      ? { ...options.extensions, prf: { evalByCredential: Object.fromEntries(Object.entries(options.extensions.prf.evalByCredential).map(([id, value]) => [id, { first: fromBase64Url(value.first) }])) } }
      : options.extensions;
    return { ...options, challenge: fromBase64Url(options.challenge), allowCredentials: (options.allowCredentials || []).map(decodeDescriptor), extensions };
  }

  function decodeDescriptor(value) { return { ...value, id: fromBase64Url(value.id) }; }

  function serializeCredential(credential) {
    const response = credential.response;
    const result = {
      id: credential.id,
      rawId: toBase64Url(new Uint8Array(credential.rawId)),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: sanitizeExtensions(credential.getClientExtensionResults?.() || {}),
      response: {
        clientDataJSON: toBase64Url(new Uint8Array(response.clientDataJSON))
      }
    };
    if (response.attestationObject) {
      result.response.attestationObject = toBase64Url(new Uint8Array(response.attestationObject));
      result.response.transports = response.getTransports?.() || [];
      result.response.publicKeyAlgorithm = response.getPublicKeyAlgorithm?.();
    } else {
      result.response.authenticatorData = toBase64Url(new Uint8Array(response.authenticatorData));
      result.response.signature = toBase64Url(new Uint8Array(response.signature));
      result.response.userHandle = response.userHandle ? toBase64Url(new Uint8Array(response.userHandle)) : undefined;
    }
    return result;
  }

  function sanitizeExtensions(value) {
    const result = {};
    if (value.credProps) result.credProps = { rk: Boolean(value.credProps.rk) };
    // PRF result is intentionally omitted: it must never leave this browser.
    if (value.prf) result.prf = { enabled: Boolean(value.prf.enabled), results: undefined };
    return result;
  }

  function readPrfOutput(credential) {
    const value = credential.getClientExtensionResults?.()?.prf?.results?.first;
    return value ? new Uint8Array(value) : null;
  }

  function supportsPrf(credential) {
    return Boolean(credential.getClientExtensionResults?.()?.prf?.enabled);
  }

  function ensureSupport() {
    if (!window.PublicKeyCredential || !navigator.credentials?.create || !navigator.credentials?.get) {
      throw new Error("このブラウザは端末のロック解除ログインに対応していません。ID・パスワードでログインしてください。");
    }
  }

  function toBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function fromBase64Url(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer;
  }

  class PasskeyCancelledError extends Error {
    constructor() { super("端末のロック解除をキャンセルしました。"); this.name = "PasskeyCancelledError"; }
  }

  window.TRoomPasskeys = Object.freeze({ authenticate, registerInvite, bootstrap, obtainPrf, api, toBase64Url, fromBase64Url, PasskeyCancelledError });
})();
