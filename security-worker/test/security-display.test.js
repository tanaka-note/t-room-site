import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

await import("../public/security-display.js");
const display = globalThis.TRoomSecurityDisplay;

const currentAuditEvents = {
  bootstrap_auth_success: "第一管理者の本人確認に成功",
  bootstrap_auth_failure: "第一管理者の本人確認に失敗",
  bootstrap_login_blocked: "第一管理者の本人確認を一時停止",
  passkey_registration: "パスキーを登録",
  passkey_login_success: "パスキーでログイン成功",
  passkey_authentication_success: "パスキーの本人確認に成功",
  passkey_authentication_failure: "パスキー認証に失敗",
  passkey_authentication_options: "パスキー認証を開始",
  passkey_dialog_cancelled: "パスキー認証をキャンセル",
  passkey_revoked: "パスキーを無効化",
  password_login_success: "パスワードでログイン成功",
  password_login_failure: "パスワードでログイン失敗",
  login_success: "ログイン成功",
  login_failure: "ログイン失敗",
  login_blocked: "ログインを一時停止",
  login_locked: "アカウントを一時停止",
  admin_access: "管理者としてアクセス",
  identity_created: "ユーザーを作成",
  identity_approved: "ユーザー利用を承認",
  invite_created: "招待URLを作成",
  invite_used: "招待からパスキーを登録",
  invite_revoked: "招待を取り消し",
  reinvite: "招待URLを再発行",
  service_link_added: "サービス連携を追加",
  service_link_removed: "サービス連携を解除",
  tcloud_key_envelope_saved: "T-Cloudのパスキー利用準備を完了",
  tcloud_setup_resumed: "T-Cloudのパスキー利用準備を再開",
  logout: "ログアウト",
  credential_compromise: "パスキーの安全上の問題を検知",
  entry_created: "請求情報を作成",
  entry_updated: "請求情報を更新",
  entry_deleted: "請求情報を削除",
  settlement_created: "精算情報を作成",
  settlement_updated: "精算情報を更新",
  settlement_deleted: "精算情報を削除"
};

test("all current Security audit event types have natural Japanese labels", () => {
  for (const [value, expected] of Object.entries(currentAuditEvents)) {
    assert.equal(display.eventLabel(value), expected, value);
    assert.ok(!display.eventLabel(value).includes(value), `${value} must not expose its internal name`);
  }
});

test("every audit event literal emitted by Security, Cloud, Diary and Billing has a display definition", async () => {
  const sources = [
    "../src/index.js",
    "../../assets/security-audit-worker.js",
    "../../cloud-worker/src/index.js",
    "../../diary-worker/src/index.js",
    "../../billing-worker/src/index.js"
  ];
  const emitted = new Set();
  for (const relative of sources) {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    for (const match of source.matchAll(/eventType\s*:\s*["']([^"']+)["']/g)) emitted.add(match[1]);
  }
  const defined = new Set(display.EVENT_DEFINITIONS.map((item) => item.value));
  assert.deepEqual([...emitted].filter((value) => !defined.has(value)), []);
});

test("unknown audit event types use an explicit fallback", () => {
  assert.equal(display.eventLabel("new_event_name"), "未定義の操作（new_event_name）");
});

test("service, outcome and authentication values keep canonical values behind Japanese labels", () => {
  assert.deepEqual(["security", "cloud", "diary", "billing"].map(display.serviceLabel), ["Security Center", "T-Cloud", "日記", "請求書"]);
  assert.deepEqual(["success", "failure", "blocked", "cancelled", "info"].map(display.outcomeLabel), ["成功", "失敗", "停止", "キャンセル", "情報"]);
  assert.deepEqual(["password", "passkey", "system"].map(display.authMethodLabel), ["パスワード", "パスキー", "システム"]);
  const filterValues = display.eventGroups().flatMap((group) => group.options.map((item) => item.value));
  for (const value of Object.keys(currentAuditEvents)) assert.ok(filterValues.includes(value), `${value} is filterable by its canonical value`);
});

test("primary administrator and common account IDs use human-friendly primary labels", () => {
  assert.equal(display.identityLabel("primary-admin"), "第一管理者");
  assert.equal(display.identityLabel("family_user", "田中太郎"), "田中太郎");
  assert.equal(display.identityLabel("family_user"), "ユーザー");
  assert.equal(display.identityLabel("", "", "main-admin"), "管理者");
  assert.equal(display.identityLabel("", "", "main-user"), "一般ユーザー");
});

test("full User-Agent strings are summarized without a heavy parser", () => {
  const cases = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36", "Windows / Chrome 151"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0", "Windows / Edge 151"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0", "Windows / Firefox 142"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", "iPhone / iOS 18.6 / Safari 18.0"],
    ["Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36", "Android 16 / Chrome 151"]
  ];
  for (const [userAgent, expected] of cases) assert.equal(display.formatUserAgent(userAgent), expected);
  assert.equal(display.formatUserAgent("custom-agent"), "不明な端末 / 不明なブラウザ");
  assert.equal(display.formatUserAgent(""), "端末情報なし");
});
