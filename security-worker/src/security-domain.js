export const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const LINKED_SERVICES = Object.freeze(["cloud", "diary", "billing"]);
export const AUDIT_SERVICES = Object.freeze(["security", ...LINKED_SERVICES]);
export const INVITE_EXPIRY_PRESETS = Object.freeze([3600, 21600, 86400, 259200, 604800]);
export const LOGIN_SUCCESS_EVENTS = Object.freeze(["password_login_success", "passkey_login_success"]);
export const LOGIN_FAILURE_EVENTS = Object.freeze(["password_login_failure", "passkey_authentication_failure", "bootstrap_auth_failure"]);
// WebAuthn Level 3 limits credential IDs to 1023 bytes.
export const MAX_CREDENTIAL_ID_BYTES = 1023;

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
  if (!Number.isInteger(Number(input.sessionEpoch)) || Number(input.sessionEpoch) !== Number(row.session_epoch)) return false;
  const expectedRoot = input.cloudRootFolderId == null ? null : Number(input.cloudRootFolderId);
  const actualRoot = row.cloud_root_folder_id == null ? null : Number(row.cloud_root_folder_id);
  return input.service === "cloud" ? expectedRoot === actualRoot : expectedRoot === null && actualRoot === null;
}

export function canonicalServiceLinks(links) {
  return (Array.isArray(links) ? links : []).map((link) => ({
    service: String(link.service || ""),
    service_account_id: String(link.service_account_id ?? link.accountId ?? ""),
    cloud_root_folder_id: link.cloud_root_folder_id == null && link.rootFolderId == null
      ? null
      : Number(link.cloud_root_folder_id ?? link.rootFolderId),
    status: String(link.status || "pending")
  })).sort(compareServiceLinks);
}

export function compareServiceLinks(left, right) {
  const service = codePointCompare(left.service, right.service);
  if (service) return service;
  const account = codePointCompare(left.service_account_id, right.service_account_id);
  if (account) return account;
  const leftRoot = left.cloud_root_folder_id == null ? -1 : Number(left.cloud_root_folder_id);
  const rightRoot = right.cloud_root_folder_id == null ? -1 : Number(right.cloud_root_folder_id);
  if (leftRoot !== rightRoot) return leftRoot - rightRoot;
  return codePointCompare(left.status, right.status);
}

export function normalizeUtcTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  const explicitUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(explicitUtc);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function validCredentialId(value) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return "";
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    const binary = atob(padded);
    if (!binary.length || binary.length > MAX_CREDENTIAL_ID_BYTES) return "";
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return canonical === text ? text : "";
  } catch {
    return "";
  }
}

export function bootstrapAttemptCutoff(now = Date.now()) {
  return new Date(now - 15 * 60 * 1000).toISOString();
}

export function auditRetentionCutoff(retentionDays, now = Date.now()) {
  const days = Math.min(730, Math.max(30, Math.trunc(Number(retentionDays) || 180)));
  return new Date(now - days * 86400000).toISOString();
}

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
