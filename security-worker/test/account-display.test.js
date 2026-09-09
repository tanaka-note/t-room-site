import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountDisplayName, identityDisplayName, auditDisplayNames, OWNER_DISPLAY_NAME as owner, USER_DISPLAY_NAME as user, LEGACY_TANAKA_USER_ID as legacy } from "../../assets/account-display.mjs";
import { auditFixture } from "./audit-history-fixture.mjs";

const names = [
  ["security", "security-admin", "security-admin", owner],
  ["cloud", "admin", "admin", owner], ["cloud", "folder-member", "member", user],
  ["diary", "main-admin", "global_owner", owner], ["diary", "main-user", "user", user],
  ["billing", "owner", "owner", owner], ["downloader", "owner", "owner", owner], ["ai", "owner", "admin", owner]
];
test("account names use Identity, service account and role; other people and unknown roles stay unchanged", () => {
  for (const [service, accountId, role, expected] of names) {
    assert.equal(accountDisplayName({ service, accountId, role, identityId: "primary-admin" }, "old"), expected);
    assert.equal(accountDisplayName({ service, accountId, role, identityId: "other-user" }, "田中暢美"), "田中暢美");
    assert.equal(accountDisplayName({ service, accountId, role: null, identityId: "primary-admin" }, "old"), "old");
  }
  for (const service of ["ai", "downloader", "cloud"]) assert.equal(accountDisplayName({ service, accountId: service === "cloud" ? "folder-member" : "owner", role: service === "cloud" ? "member" : "owner" }, "unknown"), "unknown");
  assert.equal(accountDisplayName({ service: "cloud", identityId: "primary-admin", accountId: "subadmin", role: "subadmin" }, "T-Cloud 副管理者"), "T-Cloud 副管理者");
  assert.equal(accountDisplayName({ service: "diary", accountId: "main-user", role: "user", identityId: legacy }, "old"), user);
  assert.equal(identityDisplayName("primary-admin", "第一管理者"), owner);
  assert.equal(identityDisplayName(legacy, "田中宏知一般"), user);
  assert.equal(identityDisplayName("other", "田中暢美"), "田中暢美");
});

test("historical audit API resolves each original role, leaves raw data intact, and never labels unknown use as owner", async () => {
  const f = auditFixture();
  try {
    const expected = new Map();
    for (const [service, service_account_id, role, name] of names) {
      expected.set(f.add({ identity_id: "primary-admin", service, service_account_id, role, service_account_label: "保存された原本" }), name);
    }
    expected.set(f.add({ identity_id: "primary-admin", service: "cloud", service_account_id: "subadmin", role: "subadmin" }), "田中宏知");
    expected.set(f.add({ identity_id: "primary-admin", service_account_id: null, role: null }), "田中宏知");
    expected.set(f.add({ identity_id: legacy, service: "diary", service_account_id: "main-user", role: "user" }), user);
    const events = (await f.query()).events;
    for (const event of events) assert.equal(event.actor_display_name, expected.get(event.event_id));
    assert.equal(events.filter((event) => event.service_account_label === "保存された原本").length, names.length);
    const old = { identity_id: "primary-admin", identity_display_name: owner, service: "diary", service_account_id: null, role: null };
    assert.equal(auditDisplayNames(old).actor_display_name, "田中宏知");
    assert.equal(old.identity_display_name, owner);
  } finally { f.close(); }
});

test("display migration changes exactly two names and five labels, preserves all other fields, and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(dir).filter((name) => name.endsWith(".sql") && !name.startsWith("0017")).sort()) db.exec(readFileSync(new URL(name, dir), "utf8"));
    db.exec("PRAGMA foreign_keys=ON");
    for (const [id, name] of [["primary-admin", "第一管理者"], [legacy, "田中宏知一般"], ["wife", "田中暢美"]]) db.prepare("INSERT INTO security_identities(id,display_name,status) VALUES(?,?,'disabled')").run(id, name);
    const insert = db.prepare("INSERT INTO security_service_links(id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status) VALUES(?,?,?,?,?,?,'disabled')");
    const originals = [["cloud", "admin", "T-Cloud 管理者"], ["diary", "main-admin", "日記 管理者"], ["billing", "owner", "請求書 owner"], ["ai", "owner", "AI Chat By T-lain"], ["downloader", "owner", "T-lain Downloader 管理者"]];
    for (const [service, account, label] of originals) insert.run(service, "primary-admin", service, account, null, label);
    insert.run("personal", "primary-admin", "cloud", "folder-member", 7, "Atsushi");
    insert.run("wife-folder", "wife", "cloud", "folder-member", 9, "Masami");
    insert.run("legacy", legacy, "diary", "main-user", null, user);
    insert.run("wife-downloader", "wife", "downloader", "owner", null, "T-lain Downloader 管理者");
    db.exec("INSERT INTO security_audit_events(event_id,occurred_at,service,event_type,outcome,identity_id,service_account_label) VALUES('event','2026-08-01','cloud','session_resume','success','primary-admin','T-Cloud 管理者')");
    const snapshot = () => Object.fromEntries(["security_identities", "security_service_links", "security_audit_events"].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row }))]));
    const before = snapshot(); const sql = readFileSync(new URL("0017_account_display_names.sql", dir), "utf8");
    db.exec(sql); const after = snapshot();
    assert.deepEqual(after.security_audit_events, before.security_audit_events);
    assert.deepEqual(after.security_identities, before.security_identities.map((row) => ({ ...row, display_name: row.id === "primary-admin" ? owner : row.id === legacy ? user : row.display_name })));
    assert.deepEqual(after.security_service_links, before.security_service_links.map((row) => ({ ...row, display_label: originals.some(([service]) => row.id === service) ? owner : row.display_label })));
    db.exec(sql); assert.deepEqual(snapshot(), after);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

function source(path) { return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"); }
function functionSource(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = text.slice(start + 1).search(/\n(?:async )?function /);
  return text.slice(start, end < 0 ? undefined : start + 1 + end);
}
test("raw diary names, authors, switches, sessions and Cloud folder targets remain unchanged", () => {
  for (const [path, functions] of [
    ["diary-worker/src/index.js", ["readSession", "createSessionToken", "securityAuditRole"]],
    ["billing-worker/src/index.js", ["readSession", "createSessionToken"]],
    ["cloud-worker/src/index.js", ["listSecurityFolderTargets", "createSessionToken"]],
    ["downloader-worker/src/index.js", ["requireSession", "signSession"]],
    ["ai-worker/src/index.js", ["requireSession", "signSession"]]
  ]) for (const name of functions) assert.doesNotMatch(functionSource(source(path), name), /accountDisplayName|OWNER_DISPLAY_NAME|USER_DISPLAY_NAME/, `${path}:${name}`);
  const diary = source("diary-worker/src/index.js");
  assert.match(diary, /id: MAIN_ADMIN_ACCOUNT_ID, name: "田中宏知"/);
  assert.match(diary, /id: "tanaka-household", name: "田中宏知・田中暢美"/);
  assert.match(diary, /id: "chiharu-household", name: "田中千晴"/);
  assert.match(diary, /session\.accountId, session\.accountName, session\.activeHouseholdId/);
  assert.match(diary, /session\.accountName, id, session\.activeHouseholdId, revision/);
});

test("service projections override stale display values without changing raw names or account scope", () => {
  const dependencies = { accountDisplayName, normalizeText: (s) => s || "", serviceProvider: () => ({ describeAccount: async () => ({ role: "member", displayLabel: "Atsushi", scopeLabel: "Atsushi" }) }) };
  const make = (path, name) => new Function(...Object.keys(dependencies), `${functionSource(source(path), name)}; return ${name};`)(...Object.values(dependencies));
  const cloud = make("cloud-worker/src/index.js", "publicSession");
  const session = { role: "member", label: "Atsushi", identityId: "primary-admin", serviceAccountId: "folder-member", rootFolderId: 7 };
  assert.equal(cloud(session).accountName, user); assert.equal(session.label, "Atsushi"); assert.equal(cloud(session).rootFolderId, 7);
  assert.equal(cloud({ ...session, identityId: "wife", label: "Masami", rootFolderId: 9 }).accountName, "Masami");
  assert.equal(cloud({ role: "admin", label: "管理者" }).accountName, owner);
});

test("AI and Downloader session responses resolve stale stored names without changing other users", async () => {
  const aiDependencies = { accountDisplayName, requireAccount: async (_env, id) => ({ identity_id: id, display_name: id === "primary-admin" ? "田中宏知" : "田中暢美", role: id === "primary-admin" ? "admin" : "user" }),
    usageSummary: async () => ({}), requireBudgetPolicy: async () => ({}), publicBudgetState: () => ({}), json: (body) => body };
  const ai = new Function(...Object.keys(aiDependencies), `async ${functionSource(source("ai-worker/src/index.js"), "sessionResponse")}; return sessionResponse;`)(...Object.values(aiDependencies));
  const downloader = source("downloader-worker/src/index.js").match(/accountDisplayName\(\{ service: "downloader"[^\n]+?\}, session\.displayName\)/)[0];
  const down = new Function("session", "accountDisplayName", `const SESSION_ROLE = "owner"; return ${downloader};`);
  assert.equal((await ai({}, { identityId: "primary-admin" })).user.displayName, owner);
  assert.equal((await ai({}, { identityId: "wife" })).user.displayName, "田中暢美");
  assert.equal(down({ identityId: "primary-admin", serviceAccountId: "owner", displayName: "第一管理者" }, accountDisplayName), owner);
  assert.equal(down({ identityId: "wife", serviceAccountId: "owner", displayName: "田中暢美" }, accountDisplayName), "田中暢美");
  const registry = JSON.parse(source("web-apps.json"));
  for (const id of ["security", "cloud", "diary", "billing", "downloader"]) assert.ok(registry.apps.find((app) => app.id === id).buildFiles.includes("assets/account-display.mjs"));
  assert.match(source("android-ai-chat/app/src/main/java/jp/tanaka/troom/ai/ui/AiChatApp.kt"), /Text\(session\.user\.displayName,/);
});

test("Security account choices keep folder labels, paths and target IDs separate from account names", async () => {
  const description = { role: "member", displayLabel: "Atsushi", scopeLabel: "Atsushi", roleLabel: "フォルダ利用者" };
  const dependencies = { accountDisplayName, normalizeText: (value) => value || "", serviceProvider: () => ({ describeAccount: async () => description }) };
  const publicLink = new Function(...Object.keys(dependencies), `async ${functionSource(source("security-worker/src/index.js"), "publicLink")}; return publicLink;`)(...Object.values(dependencies));
  const input = { id: "personal-cloud", identity_id: "primary-admin", service: "cloud", service_account_id: "folder-member", cloud_root_folder_id: 7, display_label: "Atsushi" };
  const result = await publicLink({}, input);
  assert.equal(result.accountDisplayName, user);
  assert.equal(result.displayLabel, "Atsushi"); assert.equal(result.scopeLabel, "Atsushi");
  assert.equal(result.id, input.id); assert.equal(result.rootFolderId, 7); assert.equal(result.accountId, "folder-member");
  description.displayLabel = description.scopeLabel = "Masami";
  const other = await publicLink({}, { ...input, identity_id: "wife", cloud_root_folder_id: 9 });
  assert.equal(other.accountDisplayName, null); assert.equal(other.displayLabel, "Masami"); assert.equal(other.rootFolderId, 9);
});
