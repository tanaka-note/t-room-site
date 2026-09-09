// Presentation only. Never use these names to authorize, identify folders,
// write diary author names, or select an account.
export const TANAKA_NAME = "田中宏知";
export const OWNER_DISPLAY_NAME = `${TANAKA_NAME}（オーナー）`;
export const USER_DISPLAY_NAME = `${TANAKA_NAME}（一般ユーザー）`;
export const LEGACY_TANAKA_USER_ID = "2545327a-96e6-4b38-ad24-a8fe85de292a";

export function identityDisplayName(identityId, fallback) {
  if (identityId === "primary-admin") return OWNER_DISPLAY_NAME;
  if (identityId === LEGACY_TANAKA_USER_ID) return USER_DISPLAY_NAME;
  return fallback;
}

export function accountDisplayName({ service, identityId, accountId, role }, fallback) {
  // Shared service accounts (Cloud folder-member, AI and Downloader owner)
  // require the person's Identity as well as the account and recorded role.
  if (identityId && !["primary-admin", LEGACY_TANAKA_USER_ID].includes(identityId)) return fallback;
  const primary = identityId === "primary-admin";
  const legacy = identityId === LEGACY_TANAKA_USER_ID;
  if (service === "diary") {
    if (!legacy && accountId === "main-admin" && ["admin", "global_owner"].includes(role)) return OWNER_DISPLAY_NAME;
    if (accountId === "main-user" && role === "user") return USER_DISPLAY_NAME;
  }
  if (!legacy && service === "cloud" && accountId === "admin" && role === "admin") return OWNER_DISPLAY_NAME;
  if (primary && service === "cloud" && accountId === "folder-member" && role === "member") return USER_DISPLAY_NAME;
  if (!legacy && service === "billing" && accountId === "owner" && role === "owner") return OWNER_DISPLAY_NAME;
  if (primary && service === "security" && accountId === "security-admin" && role === "security-admin") return OWNER_DISPLAY_NAME;
  if (primary && service === "ai" && accountId === "owner" && role === "admin") return OWNER_DISPLAY_NAME;
  if (primary && service === "downloader" && accountId === "owner" && role === "owner") return OWNER_DISPLAY_NAME;
  return fallback;
}

export function auditDisplayNames(event) {
  const resolved = accountDisplayName({ service: event.service, identityId: event.identity_id,
    accountId: event.service_account_id, role: event.role }, null);
  // An Identity may have used several roles. Its current display name is not
  // evidence of the role used by an old event, including old subadmin sessions.
  const person = ["primary-admin", LEGACY_TANAKA_USER_ID].includes(event.identity_id)
    ? TANAKA_NAME : event.identity_display_name;
  return {
    actor_display_name: resolved || person || event.service_account_label || null,
    account_display_name: resolved || event.service_account_label || null
  };
}
