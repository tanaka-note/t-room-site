export const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const LINKED_SERVICES = Object.freeze(["cloud", "diary", "billing"]);
export const AUDIT_SERVICES = Object.freeze(["security", ...LINKED_SERVICES]);
export const INVITE_EXPIRY_PRESETS = Object.freeze([3600, 21600, 86400, 259200, 604800]);
export const LOGIN_SUCCESS_EVENTS = Object.freeze(["password_login_success", "passkey_login_success"]);
export const LOGIN_FAILURE_EVENTS = Object.freeze(["password_login_failure", "passkey_authentication_failure", "bootstrap_auth_failure"]);

export function normalizeIdentityId(value) {
  const text = String(value ?? "").trim();
  return IDENTITY_ID_PATTERN.test(text) ? text : "";
}

export function normalizeLinkedService(value) {
  return LINKED_SERVICES.includes(value) ? value : "";
}

export function normalizeAuditService(value) {
  return AUDIT_SERVICES.includes(value) ? value : "";
}

export function resolveInviteExpiry(input, now = Math.floor(Date.now() / 1000), maxDays = 30) {
  const maximum = now + Math.min(30, Math.max(1, Math.trunc(Number(maxDays) || 30))) * 86400;
  if (input && Object.hasOwn(input, "expiresIn")) {
    const expiresIn = Number(input.expiresIn);
    if (!Number.isInteger(expiresIn) || !INVITE_EXPIRY_PRESETS.includes(expiresIn)) {
      throw new RangeError("招待の有効期限を確認してください。");
    }
    return now + expiresIn;
  }
  if (input && Object.hasOwn(input, "expiresAt")) {
    const expiresAt = Number(input.expiresAt);
    if (!Number.isInteger(expiresAt) || expiresAt < now + 3600 || expiresAt > maximum) {
      throw new RangeError("日時指定は1時間後から30日以内で入力してください。");
    }
    return expiresAt;
  }
  throw new RangeError("招待の有効期限を入力してください。");
}

export function jstDayBounds(dateText) {
  const text = String(dateText || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const start = new Date(`${text}T00:00:00+09:00`);
  if (Number.isNaN(start.getTime())) return null;
  const shifted = new Date(start.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (shifted !== text) return null;
  return {
    date: text,
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString()
  };
}

export function currentJstDayBounds(now = new Date()) {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return jstDayBounds(date);
}

export function passkeySessionStateMatches(input, row, enabled) {
  if (!enabled || !input || !row) return false;
  if (!normalizeIdentityId(input.identityId) || !input.credentialId || !input.serviceLinkId) return false;
  if (normalizeLinkedService(input.service) !== row.service) return false;
  if (input.identityId !== row.identity_id || input.credentialId !== row.credential_id || input.serviceLinkId !== row.link_id) return false;
  if (String(input.serviceAccountId || "") !== String(row.service_account_id || "")) return false;
  const expectedRoot = input.cloudRootFolderId == null ? null : Number(input.cloudRootFolderId);
  const actualRoot = row.cloud_root_folder_id == null ? null : Number(row.cloud_root_folder_id);
  return input.service === "cloud" ? expectedRoot === actualRoot : expectedRoot === null && actualRoot === null;
}
