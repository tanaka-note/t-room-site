(() => {
  "use strict";

  const API = "/security/api";

  async function authenticate(service, chooseLink) {
    ensureSupport();
    try {
      const start = await api("/auth/options", { service });
      const credential = await runWebAuthn("get", decodeRequestOptions(start.options), { operation: "authentication" });
      const prfOutput = readPrfOutput(credential);
      const verified = await api("/auth/verify", { service, challengeId: start.challengeId, response: serializeCredential(credential) });
      const link = verified.links.length === 1 ? verified.links[0] : await (chooseLink || chooseLinkDialog)(verified.links, service);
      if (service !== "security" && !link) throw new Error("利用するアカウントを選択してください。");
      const handoff = service === "security" ? null : await api("/auth/handoff", { service, linkId: link.id });
      return { verified, link, handoff, credentialId: verified.credentialId, prfOutput };
    } catch (error) {
      if (error?.name === "PasskeyCancelledError") {
        api("/auth/cancelled", { service }).catch(() => {});
      }
      throw error;
    }
  }

  async function registerInvite(token) {
    ensureSupport();
    const start = await api("/invite/options", { token });
    const credential = await runWebAuthn("create", decodeCreationOptions(start.options), { operation: "registration", registration: "invite" });
    const result = await api("/invite/verify", { token, challengeId: start.challengeId, response: serializeCredential(credential), prfEnabled: supportsPrf(credential) });
    const prf = await obtainPrfSafely(result.credentialId);
    return { ...result, ...prf, cloudLinks: start.cloudLinks || [] };
  }

  async function bootstrap(authProof) {
    ensureSupport();
    const start = await api("/bootstrap/options", authProof);
    const credential = await runWebAuthn("create", decodeCreationOptions(start.options), { operation: "registration", registration: "primary-admin" });
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
        prfPreparationError: userMessage(error, { operation: "verification" }, "T-Cloudのパスキー復号準備を完了できませんでした。")
      };
    }
  }

  async function obtainPrf(credentialId) {
    const start = await api("/prf/options", { credentialId });
    const credential = await runWebAuthn("get", decodeRequestOptions(start.options), { operation: "verification" });
    const prfOutput = readPrfOutput(credential);
    await api("/prf/verify", { challengeId: start.challengeId, response: serializeCredential(credential), prfAvailable: Boolean(prfOutput) });
    return { prfOutput, prfAvailable: Boolean(prfOutput), prfSalt: start.prfSalt };
  }

  async function setupStatus() {
    const response = await fetch(`${API}/setup/status`, { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeJapaneseMessage(payload.error, "T-Cloudの準備状態を確認できませんでした。"));
    return payload;
  }

  async function resumeSetup() {
    return api("/setup/resume", {});
  }

  function chooseLinkDialog(links, service = "") {
    if (!Array.isArray(links) || !links.length) return Promise.resolve(null);
    if (links.length === 1) return Promise.resolve(links[0]);
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "troom-passkey-account-dialog";
      dialog.setAttribute("aria-labelledby", "troom-passkey-account-title");
      const title = document.createElement("h2");
      title.id = "troom-passkey-account-title";
      title.textContent = service === "cloud" ? "利用するT-Cloudの範囲を選択" : "利用するアカウントを選択";
      const help = document.createElement("p");
      help.textContent = service === "cloud" ? "利用するT-Cloudの範囲を選んでください。" : "利用するアカウントを選んでください。";
      const list = document.createElement("div");
      list.className = "troom-passkey-account-list";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialog.close?.();
        dialog.remove();
        resolve(value);
      };
      for (const link of links) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "troom-passkey-account-option";
        const name = document.createElement("strong");
        name.textContent = String(link.displayLabel || "アカウント");
        button.append(name);
        const details = [link.roleLabel, link.scopeLabel].filter(Boolean);
        if (details.length) {
          const small = document.createElement("small");
          small.textContent = details.join(" / ");
          button.append(small);
        }
        button.addEventListener("click", () => finish(link));
        list.append(button);
      }
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary troom-passkey-account-cancel";
      cancel.textContent = "キャンセル";
      cancel.addEventListener("click", () => finish(null));
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
      dialog.append(title, help, list, cancel);
      document.body.append(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      list.querySelector("button")?.focus();
    });
  }

  async function api(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeJapaneseMessage(payload.error, "端末のロック解除を確認できませんでした。"));
    return payload;
  }

  async function runWebAuthn(method, publicKey, context) {
    try {
      return await navigator.credentials[method]({ publicKey });
    } catch (error) {
      throw localizedWebAuthnError(error, context);
    }
  }

  function localizedWebAuthnError(error, context = {}) {
    if (error instanceof PasskeyUserError || error instanceof PasskeyOptionsError) return error;
    const name = String(error?.name || "");
    if (name === "InvalidStateError") {
      if (context.operation !== "registration") {
        return new PasskeyUserError("パスキーの認証データを確認できませんでした。画面を再読み込みして、もう一度お試しください。", "data");
      }
      return new PasskeyUserError(context.registration === "primary-admin"
        ? "この端末またはパスワード管理サービスには、第一管理者のパスキーが既に登録されています。復旧登録ではなく、登録済みのパスキーでログインしてください。"
        : "この端末またはパスワード管理サービスには、このユーザーのパスキーが既に登録されています。新しく登録せず、管理者に現在の登録状態を確認してください。", "duplicate");
    }
    if (name === "NotAllowedError" || name === "AbortError") return new PasskeyCancelledError();
    if (name === "NotSupportedError") {
      return new PasskeyUserError("この端末またはブラウザは、必要なパスキー方式に対応していません。", "unsupported");
    }
    if (name === "SecurityError") {
      return new PasskeyUserError("このサイトではパスキーを使用できません。URLとブラウザの状態を確認してください。", "security");
    }
    if (name === "ConstraintError") {
      return new PasskeyUserError("必要な画面ロック方式を使用できません。端末の画面ロック設定を確認してください。", "constraint");
    }
    if (name === "DataError" || name === "TypeError") {
      return new PasskeyUserError("パスキーの認証データを確認できませんでした。画面を再読み込みして、もう一度お試しください。", "data");
    }
    if (name === "UnknownError" || name === "OperationError") {
      return new PasskeyUserError("端末でパスキー処理を完了できませんでした。もう一度お試しください。", "operation");
    }
    return new PasskeyUserError("端末でパスキー処理を完了できませんでした。もう一度お試しください。", "unexpected");
  }

  function userMessage(error, context = {}, fallback = "処理を完了できませんでした。もう一度お試しください。") {
    if (error instanceof PasskeyUserError || error instanceof PasskeyOptionsError) return error.message;
    if (isWebAuthnError(error)) return localizedWebAuthnError(error, context).message;
    return safeJapaneseMessage(error instanceof Error ? error.message : error, fallback);
  }

  function safeJapaneseMessage(value, fallback = "処理を完了できませんでした。もう一度お試しください。") {
    const text = String(value || "").trim();
    if (!text || !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return fallback;
    if (/\b(?:InvalidStateError|NotAllowedError|AbortError|NotSupportedError|SecurityError|ConstraintError|UnknownError|OperationError|DataError|TypeError|DOMException|WebAssembly|non-canonical)\b/i.test(text)) return fallback;
    return text;
  }

  function isWebAuthnError(error) {
    return new Set(["InvalidStateError", "NotAllowedError", "AbortError", "NotSupportedError", "SecurityError", "ConstraintError", "UnknownError", "OperationError", "DataError", "TypeError"]).has(String(error?.name || ""));
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
      ? {
          ...options.extensions,
          prf: {
            ...options.extensions.prf,
            evalByCredential: Object.fromEntries(Object.entries(options.extensions.prf.evalByCredential).map(([id, value]) => {
              fromBase64Url(id);
              return [id, decodePrfValues(value)];
            }))
          }
        }
      : options.extensions;
    return { ...options, challenge: fromBase64Url(options.challenge), allowCredentials: (options.allowCredentials || []).map(decodeDescriptor), extensions };
  }

  function decodeDescriptor(value) { return { ...value, id: fromBase64Url(value.id) }; }

  function decodePrfValues(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PasskeyOptionsError();
    const decoded = { first: fromBase64Url(value.first) };
    if (value.second !== undefined) decoded.second = fromBase64Url(value.second);
    return decoded;
  }

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
    if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
      throw new PasskeyOptionsError();
    }
    try {
      const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      if (!bytes.length || toBase64Url(bytes) !== value) throw new Error("non-canonical Base64URL");
      return bytes.buffer;
    } catch {
      throw new PasskeyOptionsError();
    }
  }

  class PasskeyOptionsError extends Error {
    constructor() {
      super("パスキーの認証情報を読み取れませんでした。画面を再読み込みしてください。改善しない場合はID・パスワードをご利用ください。");
      this.name = "PasskeyOptionsError";
    }
  }

  class PasskeyCancelledError extends Error {
    constructor() {
      super("端末のロック解除がキャンセルされたか、操作の有効期限が切れました。もう一度お試しください。");
      this.name = "PasskeyCancelledError";
      this.code = "cancelled";
    }
  }

  class PasskeyUserError extends Error {
    constructor(message, code) {
      super(message);
      this.name = "PasskeyUserError";
      this.code = code;
    }
  }

  window.TRoomPasskeys = Object.freeze({
    authenticate, registerInvite, bootstrap, obtainPrf, setupStatus, resumeSetup, chooseLinkDialog, api,
    toBase64Url, fromBase64Url, userMessage, safeJapaneseMessage,
    PasskeyCancelledError, PasskeyOptionsError, PasskeyUserError
  });
})();
