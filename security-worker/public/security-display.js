(() => {
  "use strict";

  const EVENT_DEFINITIONS = Object.freeze([
    ["bootstrap_auth_success", "第一管理者の本人確認に成功", "ログイン"],
    ["bootstrap_auth_failure", "第一管理者の本人確認に失敗", "ログイン"],
    ["bootstrap_login_blocked", "第一管理者の本人確認を一時停止", "ログイン"],
    ["password_login_success", "パスワードでログイン成功", "ログイン"],
    ["password_login_failure", "パスワードでログイン失敗", "ログイン"],
    ["passkey_login_success", "パスキーでログイン成功", "ログイン"],
    ["passkey_authentication_success", "パスキーの本人確認に成功", "ログイン"],
    ["session_resume", "保存済みセッションでアクセス", "ログイン"],
    ["passkey_authentication_options", "パスキー認証を開始", "ログイン"],
    ["passkey_authentication_failure", "パスキー認証に失敗", "ログイン"],
    ["passkey_dialog_cancelled", "パスキー認証をキャンセル", "ログイン"],
    ["login_success", "ログイン成功", "ログイン"],
    ["login_failure", "ログイン失敗", "ログイン"],
    ["login_blocked", "ログインを一時停止", "ログイン"],
    ["login_locked", "アカウントを一時停止", "ログイン"],
    ["logout", "ログアウト", "ログイン"],
    ["passkey_registration", "パスキーを登録", "パスキー"],
    ["passkey_registration_failure", "パスキー登録に失敗", "パスキー"],
    ["passkey_revoked", "パスキーを無効化", "パスキー"],
    ["credential_compromise", "パスキーの安全上の問題を検知", "パスキー"],
    ["identity_created", "ユーザーを作成", "ユーザー管理"],
    ["identity_approved", "ユーザー利用を承認", "ユーザー管理"],
    ["identity_disabled", "ユーザーを停止", "ユーザー管理"],
    ["invited_identity_retired", "未登録ユーザーを一覧から削除", "ユーザー管理"],
    ["admin_access", "管理者としてアクセス", "ユーザー管理"],
    ["invite_created", "招待URLを作成", "招待"],
    ["invite_used", "招待からパスキーを登録", "招待"],
    ["invite_revoked", "招待を取り消し", "招待"],
    ["invite_expired", "招待の有効期限が終了", "招待"],
    ["reinvite", "招待URLを再発行", "招待"],
    ["service_link_added", "サービス連携を追加", "サービス連携"],
    ["service_link_removed", "サービス連携を解除", "サービス連携"],
    ["service_link_changed", "サービス連携を変更", "サービス連携"],
    ["tcloud_key_envelope_saved", "T-Cloudのパスキー利用準備を完了", "T-Cloud"],
    ["tcloud_setup_resumed", "T-Cloudのパスキー利用準備を再開", "T-Cloud"],
    ["tcloud_key_delegated", "T-Cloudのフォルダ利用を許可", "T-Cloud"],
    ["entry_created", "請求情報を作成", "請求書"],
    ["entry_updated", "請求情報を更新", "請求書"],
    ["entry_deleted", "請求情報を削除", "請求書"],
    ["settlement_created", "精算情報を作成", "請求書"],
    ["settlement_updated", "精算情報を更新", "請求書"],
    ["settlement_deleted", "精算情報を削除", "請求書"],
    ["ai_response_completed", "AI回答を完了", "AI Chat"],
    ["ai_budget_policy_updated", "AI利用予算を変更", "AI Chat"],
    ["downloader_analyze_requested", "メディア解析を開始", "Downloader"],
    ["downloader_analyze_completed", "メディア解析を完了", "Downloader"],
    ["downloader_analyze_failed", "メディア解析に失敗", "Downloader"],
    ["downloader_ssrf_blocked", "安全でないURLへのアクセスを拒否", "Downloader"],
    ["downloader_download_requested", "メディア取得を開始", "Downloader"],
    ["downloader_download_started", "隔離環境でメディア取得を開始", "Downloader"],
    ["downloader_scan_passed", "メディアの安全性検査を完了", "Downloader"],
    ["downloader_download_completed", "メディア取得と検査を完了", "Downloader"],
    ["downloader_download_failed", "メディア取得または検査に失敗", "Downloader"],
    ["downloader_deleted", "一時ファイルを削除", "Downloader"],
    ["security_settings_changed", "セキュリティ設定を変更", "システム"],
    ["crypto_initialized", "T-Cloudの暗号化を初期設定", "システム"]
  ].map(([value, label, group]) => Object.freeze({ value, label, group })));

  const EVENT_LABELS = new Map(EVENT_DEFINITIONS.map((item) => [item.value, item.label]));
  const SERVICE_LABELS = Object.freeze({ security: "Security Center", cloud: "T-Cloud", diary: "日記", billing: "請求書", ai: "AI Chat", downloader: "T-lain Downloader" });
  const OUTCOME_LABELS = Object.freeze({ success: "成功", failure: "失敗", blocked: "停止", cancelled: "キャンセル", info: "情報" });
  const AUTH_METHOD_LABELS = Object.freeze({ password: "パスワード", passkey: "パスキー", system: "システム" });
  const ROLE_LABELS = Object.freeze({ admin: "管理者", "security-admin": "管理者", identity: "ユーザー", subadmin: "副管理者", owner: "管理者", member: "一般ユーザー", user: "一般ユーザー", global_owner: "全体管理者" });
  const STATUS_LABELS = Object.freeze({
    invited: "招待中", pending_approval: "承認待ち", active: "利用可能", disabled: "停止",
    pending: "承認待ち", revoked: "無効", used: "使用済み", expired: "期限切れ",
    completed: "完了", cancelled: "取消済み"
  });
  const IDENTITY_STATUS_LABELS = Object.freeze({
    invited: "招待中", pending_approval: "管理者承認待ち", active: "利用可能", disabled: "停止"
  });
  const INVITATION_STATUS_LABELS = Object.freeze({
    active: "有効", used: "使用済み", revoked: "取消済み", expired: "期限切れ"
  });

  function mappedLabel(labels, value, fallback) {
    const normalized = String(value || "").trim();
    return labels[normalized] || fallback(normalized);
  }

  function eventLabel(value) {
    const normalized = String(value || "").trim() || "unknown";
    return EVENT_LABELS.get(normalized) || `未定義の操作（${normalized}）`;
  }

  function serviceLabel(value) {
    return mappedLabel(SERVICE_LABELS, value, (item) => item ? `未定義のサービス（${item}）` : "サービス不明");
  }

  function outcomeLabel(value) {
    return mappedLabel(OUTCOME_LABELS, value, (item) => item ? `未定義の結果（${item}）` : "結果不明");
  }

  function authMethodLabel(value) {
    return mappedLabel(AUTH_METHOD_LABELS, value, (item) => item ? `未定義の認証方式（${item}）` : "認証情報なし");
  }

  function roleLabel(value) {
    return mappedLabel(ROLE_LABELS, value, (item) => item || "権限情報なし");
  }

  function statusLabel(value) {
    return mappedLabel(STATUS_LABELS, value, (item) => item ? `状態: ${item}` : "状態不明");
  }

  function identityStatusLabel(value) {
    return mappedLabel(IDENTITY_STATUS_LABELS, value, (item) => item ? `状態: ${item}` : "状態不明");
  }

  function invitationStatusLabel(value) {
    return mappedLabel(INVITATION_STATUS_LABELS, value, (item) => item ? `状態: ${item}` : "状態不明");
  }

  function invitationEffectiveStatus(invitation, currentSeconds = Math.floor(Date.now() / 1000)) {
    const status = String(invitation?.status || "").trim();
    const expiresAt = Number(invitation?.expires_at);
    return status === "active" && Number.isSafeInteger(expiresAt) && expiresAt > 0 && expiresAt <= currentSeconds
      ? "expired"
      : status;
  }

  function formatInvitationExpiry(value) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return "期限情報を取得できません";
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 9999) return "期限情報を取得できません";
    return date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  }

  function serviceLinkStatusLabel(value, { identityStatus = "", service = "", hasCredential = false } = {}) {
    const status = String(value || "").trim();
    if (identityStatus === "invited" && ["pending", "active"].includes(status)) return "登録待ち";
    if (status === "active") return "利用可能";
    if (status === "disabled") return "停止";
    if (status === "pending") {
      if (identityStatus === "pending_approval") {
        if (service === "cloud") return hasCredential ? "鍵委譲待ち" : "端末準備待ち";
        return "管理者承認待ち";
      }
    }
    return statusLabel(status);
  }

  function serviceAccountLabel(service, accountId) {
    const key = `${String(service || "")}:${String(accountId || "")}`;
    return ({
      "cloud:admin": "管理者", "cloud:subadmin": "副管理者", "cloud:folder-member": "フォルダ利用者",
      "diary:main-admin": "管理者アカウント", "diary:main-user": "一般ユーザーアカウント",
      "billing:owner": "管理者アカウント", "billing:member": "一般ユーザーアカウント",
      "ai:owner": "AI利用者", "downloader:owner": "Downloader管理者"
    })[key] || "サービス内アカウント";
  }

  function identityLabel(identityId, displayName, serviceAccountId, role) {
    const id = String(identityId || "").trim();
    if (id === "primary-admin") return "第一管理者";
    if (displayName) return String(displayName);
    if (role) return roleLabel(role);
    if (serviceAccountId === "main-admin") return "管理者";
    if (serviceAccountId === "main-user") return "一般ユーザー";
    if (id) return "ユーザー";
    return String(serviceAccountId || "").trim() ? "サービス利用者" : "ユーザー不明";
  }

  function formatUserAgent(value) {
    const userAgent = String(value || "").trim();
    if (!userAgent) return "端末情報なし";

    let operatingSystem = "不明な端末";
    let match;
    if ((match = userAgent.match(/(?:CPU )?iPhone OS ([\d_]+)/i))) operatingSystem = `iPhone / iOS ${match[1].replaceAll("_", ".")}`;
    else if ((match = userAgent.match(/CPU OS ([\d_]+) like Mac OS X/i)) && /iPad/i.test(userAgent)) operatingSystem = `iPad / iPadOS ${match[1].replaceAll("_", ".")}`;
    else if ((match = userAgent.match(/Android\s+([\d.]+)/i))) operatingSystem = `Android ${match[1]}`;
    else if (/Windows NT/i.test(userAgent)) operatingSystem = "Windows";
    else if ((match = userAgent.match(/Mac OS X\s+([\d_]+)/i))) operatingSystem = `macOS ${match[1].replaceAll("_", ".")}`;

    let browser = "不明なブラウザ";
    if ((match = userAgent.match(/(?:EdgA|EdgiOS|Edg)\/([\d]+)/i))) browser = `Edge ${match[1]}`;
    else if ((match = userAgent.match(/(?:CriOS|Chrome)\/([\d]+)/i))) browser = `Chrome ${match[1]}`;
    else if ((match = userAgent.match(/(?:FxiOS|Firefox)\/([\d]+)/i))) browser = `Firefox ${match[1]}`;
    else if ((match = userAgent.match(/Version\/([\d]+(?:\.\d+)?).*Safari\//i))) browser = `Safari ${match[1]}`;

    return `${operatingSystem} / ${browser}`;
  }

  function eventGroups() {
    const groups = new Map();
    for (const item of EVENT_DEFINITIONS) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push({ value: item.value, label: item.label });
    }
    return [...groups].map(([label, options]) => ({ label, options }));
  }

  globalThis.TRoomSecurityDisplay = Object.freeze({
    EVENT_DEFINITIONS, eventLabel, serviceLabel, outcomeLabel, authMethodLabel, roleLabel,
    statusLabel, identityStatusLabel, invitationStatusLabel, invitationEffectiveStatus,
    formatInvitationExpiry, serviceLinkStatusLabel, serviceAccountLabel, identityLabel,
    formatUserAgent, eventGroups
  });
})();
