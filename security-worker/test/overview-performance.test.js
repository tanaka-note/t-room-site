import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LOGIN_SUCCESS_EVENTS, LOGIN_FAILURE_EVENTS } from "../src/security-domain.js";

const worker = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const cloud = readFileSync(new URL("../../cloud-worker/src/index.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/security.js", import.meta.url), "utf8");
function handler(source, name, dependencies) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const next = source.slice(start + 1).search(/\n(?:\s*(?:async )?function |export )/);
  const end = next < 0 ? source.lastIndexOf("})();") : start + 1 + next;
  return new Function(...Object.keys(dependencies), `${source.slice(start, end)}; return ${name};`)(...Object.values(dependencies));
}
function gate() {
  let release;
  return { promise: new Promise((resolve) => { release = resolve; }), release: () => release() };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("overview counts only the current JST day and uses the existing audit range index", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE security_audit_events (occurred_at TEXT, event_type TEXT, outcome TEXT);
      CREATE INDEX idx_security_audit_occurred ON security_audit_events(occurred_at DESC);
      CREATE TABLE security_identities (id TEXT, status TEXT);
      CREATE TABLE security_credentials (identity_id TEXT, status TEXT);
      INSERT INTO security_identities VALUES ('active','active'),('pending','invited'),('disabled','disabled');
      INSERT INTO security_credentials VALUES ('active','active'),('pending','pending');`);
    const insert = db.prepare("INSERT INTO security_audit_events VALUES (?,?,?)");
    const start = "2026-10-12T15:00:00.000Z", end = "2026-10-13T15:00:00.000Z";
    for (const event of LOGIN_SUCCESS_EVENTS) insert.run(start, event, "success");
    for (const event of LOGIN_FAILURE_EVENTS) insert.run("2026-10-13T14:59:59.999Z", event, "failure");
    insert.run(start, "login_locked", "blocked");
    insert.run(start, "session_resume", "success");
    insert.run(start, "credential_compromise", "failure");
    insert.run(start, "admin_access", "success");
    insert.run(start, "passkey_authentication_options", "info");
    insert.run("2026-10-12T14:59:59.999Z", "password_login_success", "success");
    insert.run(end, "password_login_failure", "failure");
    let auditPlan;
    const waiting = gate(), started = [];
    const env = { DB: { prepare(sql) {
      let values = [];
      const query = { bind(...args) { values = args; return query; }, async first() {
        started.push(sql.includes("FROM security_audit_events") ? "audit" : "identities");
        if (sql.includes("FROM security_audit_events")) auditPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values);
        await waiting.promise;
        return db.prepare(sql).get(...values);
      } };
      return query;
    } } };
    const dashboard = handler(worker, "dashboard", {
      currentJstDayBounds: () => ({ start, end }), LOGIN_SUCCESS_EVENTS, LOGIN_FAILURE_EVENTS,
      activeSessionState: async () => { started.push("sessions"); await waiting.promise; return { users: [{ identityId: "active", services: ["cloud"] }] }; },
      readDefinitionStatus: async () => { started.push("definitions"); await waiting.promise; return { result: "success" }; },
      json: (body) => body
    });
    const pending = dashboard(env);
    await turn();
    assert.deepEqual(started, ["audit", "identities", "sessions", "definitions"], "independent reads start together");
    waiting.release();
    const result = await pending;
    assert.deepEqual([result.loginSuccess, result.loginFailure, result.lockouts, result.sessionResume, result.critical], [2, 3, 1, 1, 2]);
    assert.deepEqual([result.pendingApproval, result.invited, result.noPasskey], [1, 1, 1]);
    assert.equal(result.activeUsers[0].identityId, "active");
    assert.equal(result.clamavDefinitions.result, "success");
    assert.ok(auditPlan.some((row) => /SEARCH.*idx_security_audit_occurred.*occurred_at[<>]/.test(row.detail)), JSON.stringify(auditPlan));
    db.exec("DELETE FROM security_audit_events");
    assert.equal((await dashboard(env)).loginSuccess, 0, "empty sums remain zero");
  } finally { db.close(); }
});

test("all service candidates start together, preserve registry order, and still report provider failure", async () => {
  const ids = ["cloud", "diary", "billing", "ai", "downloader", "downloader2"];
  const waiting = gate(), calls = [];
  let failing = false;
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const list = handler(worker, "listServiceRegistry", {
    SERVICE_REGISTRY: Object.fromEntries(ids.map((id) => [id, { displayName: id }])), HttpError,
    serviceProvider: (_env, id) => ({ async listLinkTargets() {
      calls.push(id); await waiting.promise;
      if (failing && id === "diary") throw new Error("offline");
      return { displayName: id, targets: [{ accountId: id }] };
    } }), normalizeText: (value) => value, publicServiceTarget: (_id, value) => value, json: (body) => body
  });
  const pending = list({}); await turn();
  assert.deepEqual(calls, ids);
  waiting.release();
  assert.deepEqual((await pending).services.map((service) => service.id), ids);
  failing = true;
  await assert.rejects(list({}), (error) => error.status === 503 && /diary/.test(error.message));
});

test("parallel runtime reads deduplicate accounts while retaining version, revocation, epoch and folder checks", async () => {
  const waiting = gate(), calls = [], scopeCalls = [];
  let globalRuntime = { enabled: true, epoch: 9 };
  const base = { identity_id: "user", display_name: "User", service: "diary", service_account_id: "main-user",
    session_version: "v1", auth_method: "passkey", passkey_session_epoch: 9, credential_status: "active", link_status: "active" };
  const row = (id, overrides = {}) => ({ ...base, id, ...overrides });
  const rows = [row("valid"), row("duplicate"), row("password", { auth_method: "password", credential_status: null, link_status: null }),
    row("stale-version", { session_version: "old" }), row("stale-epoch", { passkey_session_epoch: 8 }),
    row("revoked-credential", { credential_status: "revoked" }), row("disabled-link", { link_status: "disabled" }),
    row("disabled-provider", { service: "billing", service_account_id: "owner" }),
    row("unavailable", { service: "ai", service_account_id: "owner" }),
    row("folders", { service: "cloud", service_account_id: "folder-member", cloud_folder_scopes: '[{"rootFolderId":7}]', service_link_id: "anchor" }),
    row("revoked-folder", { service: "cloud", service_account_id: "folder-member", cloud_folder_scopes: '[{"rootFolderId":9}]', service_link_id: "anchor" }),
    row("invalid-folder", { service: "cloud", service_account_id: "folder-member", cloud_folder_scopes: "invalid" }),
    row("unsupported", { service: "security" })];
  const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } };
  const active = handler(worker, "activeSessionState", {
    nowSeconds: () => 100, observePasskeyRuntime: async () => globalRuntime, passkeysEnabled: () => true,
    ACTIVE_SESSION_SERVICE_IDS: ["cloud", "diary", "billing", "ai", "downloader", "downloader2"],
    serviceProvider: (_env, service) => ({ async getSessionRuntimeState({ serviceAccountId }) {
      calls.push(`${service}/${serviceAccountId}`); await waiting.promise;
      if (service === "ai") throw new Error("offline");
      return { sessionVersion: "v1", passkeyEnabled: service !== "billing" };
    } }), publicActiveSession: (session) => session.id, identityDisplayName: (_id, name) => name,
    parseJson: (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } },
    normalizeCloudFolderScopes: (value) => Array.isArray(value) ? value : null,
    validCloudFolderScopes: async (_env, _identity, _credential, scopes) => { scopeCalls.push(scopes[0].rootFolderId); return scopes[0].rootFolderId === 7; }
  });
  const pending = active(env); await turn();
  assert.deepEqual(calls, ["diary/main-user", "billing/owner", "ai/owner", "cloud/folder-member"]);
  waiting.release();
  const result = await pending;
  assert.deepEqual(result.services.flatMap((service) => service.sessions).sort(), ["duplicate", "folders", "password", "valid"]);
  assert.deepEqual(scopeCalls, [7, 9]);
  assert.equal(result.services.find((service) => service.service === "ai").available, false);
  globalRuntime = { enabled: false, epoch: 10 };
  const disabled = await active(env);
  assert.deepEqual(disabled.services.flatMap((service) => service.sessions), ["password"]);
  assert.equal(calls.length, 8, "runtime state is fetched again for each request");
});

test("top-level Cloud targets read roots directly; full paths and deletion exclusions are preserved", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE cloud_folders (id INTEGER, parent_id INTEGER, name TEXT, deleted_at TEXT);
      INSERT INTO cloud_folders VALUES (1,NULL,'Beta',NULL),(2,NULL,'alpha',NULL),(3,1,'Child',NULL),
      (4,3,'Nested',NULL),(5,NULL,'Deleted','today'),(6,5,'Hidden',NULL),(7,1,'Removed','today');`);
    let selectedRows;
    const list = handler(cloud, "listSecurityFolderTargets", {});
    const env = { DB: { prepare: (sql) => ({ all: async () => {
      selectedRows = db.prepare(sql).all(); return { results: selectedRows };
    } }) } };
    const roots = await list(env, { topLevelOnly: true });
    assert.equal(selectedRows.length, 2, "descendants are not loaded merely to be discarded");
    assert.deepEqual(roots.map((target) => [target.rootFolderId, target.displayLabel]), [[2, "alpha"], [1, "Beta"]]);
    const all = await list(env);
    assert.deepEqual(all.map((target) => target.displayLabel), ["alpha", "Beta", "Beta / Child", "Beta / Child / Nested"]);
    assert.ok(all.every((target) => target.accountId === "folder-member"));
  } finally { db.close(); }
});

test("read deadline includes JSON consumption and never aborts or retries a mutation", async () => {
  let timeout, options, fetches = 0, cleared = 0;
  const dependencies = { AbortController, SyntaxError, JSON,
    setTimeout: (callback, delay) => { assert.equal(delay, 15000); timeout = callback; return 1; },
    clearTimeout: () => { cleared++; }, TRoomPasskeys: { safeJapaneseMessage: (value) => value },
    fetch: async (_url, init) => { options = init; fetches++; return { ok: true, json: async () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) }; }
  };
  const request = handler(client, "request", dependencies);
  const reading = request("/dashboard"); await turn(); timeout();
  await assert.rejects(reading, /読み込みに時間/);
  assert.equal(options.method, "GET"); assert.equal(cleared, 1);
  const mutate = handler(client, "request", { ...dependencies, setTimeout: () => assert.fail("mutation must not start a deadline"),
    fetch: async (_url, init) => { options = init; fetches++; return { ok: true, json: async () => ({ saved: true }) }; } });
  assert.deepEqual(await mutate("/identities", { displayName: "User" }), { saved: true });
  assert.equal(options.method, "POST"); assert.equal(options.signal, undefined); assert.equal(fetches, 2);
  const invalid = handler(client, "request", { ...dependencies, fetch: async () => ({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } }) });
  await assert.rejects(invalid("/dashboard"), /取得した情報を確認できません/);
});

test("an older overview response cannot replace a newer result or clear its loading state", async () => {
  const reads = [];
  const state = { dashboardRequest: 0 };
  const panel = { innerHTML: "", attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  const load = handler(client, "loadDashboard", {
    state, $: () => panel, get: () => new Promise((resolve) => { reads.push(resolve); }),
    escapeHtml: (value) => String(value), display: {}
  });
  const old = load(), current = load();
  reads[0]({ loginSuccess: 99 }); await old;
  assert.equal(panel.attributes["aria-busy"], "true");
  assert.match(panel.innerHTML, /読み込んでいます/);
  reads[1]({ loginSuccess: 37 }); await current;
  assert.match(panel.innerHTML, /今日のログイン成功<\/span><strong>37<\/strong>/);
  assert.equal(panel.attributes["aria-busy"], "false");
  const delayed = load(), newest = load();
  reads[3]({ loginSuccess: 38 }); await newest;
  const html = panel.innerHTML;
  reads[2]({ loginSuccess: 100 }); await delayed;
  assert.equal(panel.innerHTML, html);
  assert.equal(state.dashboardLoaded, true);
});

test("initial overview, users, candidates and audit start independently even when identities fail", async () => {
  const started = [], errors = [], identities = gate();
  const show = handler(client, "showAdmin", {
    $: () => ({ hidden: true }), renderPrimarySetupNotice: () => {},
    loadDashboard: async () => { started.push("dashboard"); },
    prepareServiceLinks: async () => { started.push("services"); },
    loadIdentities: async () => { started.push("identities"); await identities.promise; throw new Error("identity failure"); },
    loadAudit: async () => { started.push("audit"); },
    showMessage: message => errors.push(message)
  });
  const pending = show({ active: false }); await turn();
  assert.deepEqual(started, ["dashboard", "services", "identities", "audit"]);
  identities.release(); await pending;
  assert.deepEqual(errors, ["identity failure"]);
});

test("candidate readers share a pending request, can retry failure, and refresh on administrator reentry", async () => {
  const reads = [], state = { services: [], servicesPromise: null };
  const load = handler(client, "loadServices", { state, get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) });
  const first = load(), second = load();
  assert.equal(reads.length, 1);
  reads[0].reject(new Error("offline"));
  assert.equal((await Promise.allSettled([first, second])).every((result) => result.status === "rejected"), true);
  const retry = load(); reads[1].resolve({ services: [{ id: "diary", targets: [] }] }); await retry;
  await load(); assert.equal(reads.length, 2);
  const refresh = load({ refresh: true });
  reads[2].resolve({ services: [{ id: "cloud", targets: [{ rootFolderId: 7 }] }] }); await refresh;
  assert.equal(state.services[0].id, "cloud");
});
