import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
// Intentional exact allowlist. Adding a person/service requires a reviewed change.
// Cloud, the primary administrator, other/current/future accounts are protected.
export const MANAGED_PASSWORD_ACCOUNTS = Object.freeze([
  Object.freeze({ service: "diary", accountId: "chiharu-admin", displayName: "田中千晴" }),
  Object.freeze({ service: "diary", accountId: "wife-admin", displayName: "田中暢美", static: true }),
  Object.freeze({ service: "billing", accountId: "chiharu", displayName: "田中千晴" }),
  Object.freeze({ service: "billing", accountId: "masami", displayName: "田中暢美" })
]);

export function managedPasswordAccount(service, accountId) {
  const target = MANAGED_PASSWORD_ACCOUNTS.find((item) => item.service === service && item.accountId === accountId);
  if (!target) throw new Error("対象外です。許可されたservice/account_idの完全一致が必要です。");
  return target;
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function changePasswordPolicySql(target, enabled, epoch, reason) {
  target = managedPasswordAccount(target.service, target.accountId);
  if (typeof enabled !== "boolean" || !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid policy transition");
  if (!reason || reason.length > 200) throw new Error("理由は1〜200文字で指定してください。秘密情報を含めないでください。");
  const service = quote(target.service), id = quote(target.accountId), name = quote(target.displayName);
  const accountGuard = target.static ? "1 = 1" : `EXISTS (SELECT 1 FROM ${target.service}_accounts WHERE id = ${id} AND display_name = ${name} AND ${target.service === "diary" ? "active" : "is_active"} = 1)`;
  // One statement/one primary key, with optimistic concurrency and an atomic
  // audit trigger. Never delete a row or reset the epoch, even on recovery.
  return `INSERT INTO password_auth_policy
    (service, account_id, password_auth_enabled, password_session_epoch, changed_by, reason)
    SELECT ${service}, ${id}, ${Number(enabled)}, ${epoch + 1}, 'Codex / explicit administrator instruction', ${quote(reason)}
    WHERE ${accountGuard} AND NOT EXISTS (SELECT 1 FROM password_auth_policy WHERE service = ${service} AND account_id = ${id}) AND ${epoch} = 0
    ON CONFLICT(service, account_id) DO NOTHING
    RETURNING service, account_id, password_auth_enabled, password_session_epoch`;
}

export function updatePasswordPolicySql(target, enabled, epoch, reason) {
  target = managedPasswordAccount(target.service, target.accountId);
  // Reuse validation, but retain the row and advance its existing epoch.
  changePasswordPolicySql(target, enabled, epoch, reason);
  const accountGuard = target.static ? "1 = 1" : `EXISTS (SELECT 1 FROM ${target.service}_accounts WHERE id = ${quote(target.accountId)} AND display_name = ${quote(target.displayName)} AND ${target.service === "diary" ? "active" : "is_active"} = 1)`;
  return `UPDATE password_auth_policy SET password_auth_enabled = ${Number(enabled)}, password_session_epoch = password_session_epoch + 1,
    changed_by = 'Codex / explicit administrator instruction', reason = ${quote(reason)}, updated_at = CURRENT_TIMESTAMP
    WHERE service = ${quote(target.service)} AND account_id = ${quote(target.accountId)} AND password_session_epoch = ${epoch}
      AND password_auth_enabled = ${Number(!enabled)} AND ${accountGuard}
    RETURNING service, account_id, password_auth_enabled, password_session_epoch`;
}

export async function inspectPasswordAccount(target, query) {
  target = managedPasswordAccount(target.service, target.accountId);
  let accounts;
  if (target.static) {
    const source = readFileSync(resolve(root, "diary-worker/src/index.js"), "utf8");
    if (!source.includes('const WIFE_ADMIN_ACCOUNT_ID = "wife-admin";')) throw new Error("固定アカウントIDが変更されています。");
    const name = source.match(/\{ id: WIFE_ADMIN_ACCOUNT_ID, name: "([^"]+)"/)?.[1];
    const shadows = await query("diary", `SELECT id FROM diary_accounts WHERE id = ${quote(target.accountId)}`);
    if (shadows.length) throw new Error("固定アカウントとD1が重複しています。変更を中止します。");
    accounts = [{ account_id: target.accountId, display_name: name, active: 1, source: "DIARY_ACCOUNTS (static)" }];
  } else {
    accounts = await query(target.service, `SELECT id AS account_id, display_name, ${target.service === "diary" ? "active" : "is_active"} AS active FROM ${target.service}_accounts WHERE id = ${quote(target.accountId)}`);
  }
  if (accounts.length !== 1 || accounts[0].account_id !== target.accountId || accounts[0].display_name !== target.displayName || accounts[0].active !== 1) {
    throw new Error("対象アカウントの件数・氏名・有効状態が想定と一致しません。変更を中止します。");
  }
  const policies = await query(target.service, `SELECT service, account_id, password_auth_enabled, password_session_epoch FROM password_auth_policy WHERE service = ${quote(target.service)} AND account_id = ${quote(target.accountId)}`);
  if (policies.length > 1 || (policies.length === 1 && (
    policies[0].service !== target.service || policies[0].account_id !== target.accountId
    || ![0, 1].includes(policies[0].password_auth_enabled)
    || !Number.isSafeInteger(policies[0].password_session_epoch) || policies[0].password_session_epoch < 1
  ))) throw new Error("Passwordポリシーの状態が不正です。変更を中止します。");
  const links = await query("security", `SELECT l.service, l.service_account_id AS account_id, i.display_name,
    i.status AS identity_status, l.status AS link_status,
    (SELECT COUNT(*) FROM security_credentials c WHERE c.identity_id = i.id AND c.status = 'active') AS active_credentials
    FROM security_service_links l JOIN security_identities i ON i.id = l.identity_id
    WHERE l.service = ${quote(target.service)} AND l.service_account_id = ${quote(target.accountId)} AND l.status = 'active'`);
  return { service: target.service, ...accounts[0], policyExists: policies.length === 1,
    passwordAuthEnabled: policies.length ? policies[0].password_auth_enabled === 1 : true,
    passwordSessionEpoch: policies[0]?.password_session_epoch ?? 0, passkeyLinks: links };
}

export async function setPasswordAccount(target, action, options, query) {
  target = managedPasswordAccount(target.service, target.accountId);
  if (!["enable", "disable"].includes(action)) throw new Error("enableまたはdisableを指定してください。");
  const before = await inspectPasswordAccount(target, query);
  console.log(JSON.stringify({ before }));
  if (options.expectName !== before.display_name || options.expectEpoch !== before.passwordSessionEpoch) throw new Error("氏名または世代番号が一致しません。再確認してください。");
  if (action === "disable" && (before.passkeyLinks.length !== 1 || before.passkeyLinks[0].display_name !== target.displayName || before.passkeyLinks[0].identity_status !== "active" || before.passkeyLinks[0].active_credentials < 1)) {
    throw new Error("有効なPasskey連携を一意に確認できません。停止を中止します。");
  }
  const enabled = action === "enable";
  if (before.passwordAuthEnabled === enabled) return { before, after: before, changed: false };
  const sql = before.policyExists ? updatePasswordPolicySql(target, enabled, before.passwordSessionEpoch, options.reason)
    : changePasswordPolicySql(target, enabled, before.passwordSessionEpoch, options.reason);
  const changed = await query(target.service, sql);
  if (changed.length !== 1 || changed[0].service !== target.service || changed[0].account_id !== target.accountId) throw new Error("競合または想定外の変更件数です。再読込して確認してください。");
  const after = await inspectPasswordAccount(target, query);
  if (after.passwordAuthEnabled !== enabled || after.passwordSessionEpoch !== before.passwordSessionEpoch + 1) throw new Error("変更後の確認に失敗しました。");
  return { before, after, changed: true };
}

export function wranglerQuery(remote, persistTo) {
  return async (service, sql) => {
    if (!["diary", "billing", "security"].includes(service)) throw new Error("Invalid service");
    const args = [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", `${service}-db`, "-c", resolve(root, `${service}-worker/wrangler.jsonc`), remote ? "--remote" : "--local", "--command", sql, "--json"];
    if (!remote && persistTo) args.push("--persist-to", resolve(persistTo));
    let output;
    try { output = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new Error("D1操作を確認できませんでした。書き込みは自動再試行せず、inspectで状態を確認してください。"); }
    const result = JSON.parse(output);
    if (result.length !== 1 || result[0].success !== true) throw new Error("Unexpected D1 result");
    return result[0].results;
  };
}

async function main(args) {
  const [action, service, accountId, ...flags] = args;
  const target = managedPasswordAccount(service, accountId);
  const options = {};
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (["--remote", "--local", "--apply"].includes(flag)) options[flag] = true;
    else if (["--expect-name", "--expect-epoch", "--reason", "--persist-to"].includes(flag) && flags[i + 1] && !flags[i + 1].startsWith("--")) options[flag] = flags[++i];
    else throw new Error(`不明な引数: ${flag}`);
  }
  if (Boolean(options["--remote"]) === Boolean(options["--local"])) throw new Error("--localまたは--remoteを明示してください。");
  const query = wranglerQuery(Boolean(options["--remote"]), options["--persist-to"]);
  if (action === "inspect") return console.log(JSON.stringify(await inspectPasswordAccount(target, query), null, 2));
  if (!options["--apply"] || options["--expect-epoch"] == null) throw new Error("書き込みには--apply、--expect-name、--expect-epoch、--reasonが必要です。");
  console.log(JSON.stringify(await setPasswordAccount(target, action, { expectName: options["--expect-name"], expectEpoch: Number(options["--expect-epoch"]), reason: options["--reason"] }, query), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
