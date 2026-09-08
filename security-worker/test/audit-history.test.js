import assert from "node:assert/strict";
import test from "node:test";
import { auditFixture } from "./audit-history-fixture.mjs";

test("password preset includes real cross-service results and excludes resumes and administrative activity", async () => {
  const f = auditFixture();
  try {
    const expected = [];
    for (const service of ["cloud", "diary", "billing"]) {
      for (const [event_type, outcome] of [["password_login_success", "success"], ["password_login_failure", "failure"], ["login_blocked", "blocked"]]) {
        expected.push(f.add({ service, event_type, outcome }));
      }
    }
    expected.push(f.add({ service: "billing", event_type: "login_locked", outcome: "blocked" }));
    for (const [event_type, outcome] of [["bootstrap_auth_success", "success"], ["bootstrap_auth_failure", "failure"], ["bootstrap_login_blocked", "blocked"]]) {
      expected.push(f.add({ service: "security", event_type, outcome }));
    }
    expected.push(f.add({ event_type: "login_success" }));
    for (const event_type of ["session_resume", "logout", "admin_access", "entry_created", "crypto_initialized", "future_login_success"]) f.add({ event_type });
    f.add({ event_type: "passkey_login_success", auth_method: "passkey" });
    f.add({ event_type: "login_success", auth_method: null });
    f.add({ event_type: "password_login_success", outcome: "info" });
    assert.deepEqual((await f.query("view=password")).events.map((row) => row.event_id), expected);
  } finally { f.close(); }
});

test("passkey and attention presets use recorded outcomes and exclude informational/administrative events", async () => {
  const f = auditFixture();
  try {
    const passkey = [], attention = [];
    for (const service of ["security", "cloud", "diary", "billing", "ai", "downloader"]) {
      passkey.push(f.add({ service, event_type: "passkey_login_success", auth_method: "passkey" }));
      passkey.push(f.add({ service, event_type: "passkey_authentication_success", auth_method: "passkey" }));
      const failed = f.add({ service, event_type: "passkey_authentication_failure", auth_method: "passkey", outcome: "failure" });
      passkey.push(failed); attention.push(failed);
    }
    for (const [event_type, outcome, auth_method] of [
      ["password_login_failure", "failure", "password"], ["login_locked", "blocked", "password"],
      ["bootstrap_login_blocked", "blocked", "password"], ["login_failure", "failure", null], ["login_blocked", "blocked", "system"]
    ]) attention.push(f.add({ event_type, outcome, auth_method }));
    for (const [event_type, outcome] of [
      ["passkey_authentication_options", "info"], ["passkey_dialog_cancelled", "cancelled"],
      ["session_resume", "success"], ["passkey_registration", "success"], ["passkey_registration_failure", "failure"],
      ["identity_disabled", "success"], ["downloader_ssrf_blocked", "blocked"], ["downloader_download_failed", "failure"]
    ]) f.add({ event_type, outcome, auth_method: "passkey" });
    assert.deepEqual((await f.query("view=passkey")).events.map((row) => row.event_id), passkey);
    assert.deepEqual((await f.query("view=attention")).events.map((row) => row.event_id), attention);
    assert.deepEqual(await f.query("view=all"), await f.query(), "legacy API without view remains unchanged");
    assert.equal((await f.query()).events.length, 31);
    await assert.rejects(f.query("view=invalid"), { status: 400 });
  } finally { f.close(); }
});

test("presets intersect every advanced filter, JST boundaries and stable composite pagination", async () => {
  const f = auditFixture();
  try {
    const ids = Array.from({ length: 103 }, () => f.add());
    f.add({ event_type: "session_resume" });
    f.add({ identity_id: "another" });
    f.add({ service: "diary" });
    f.add({ occurred_at: "2026-09-07T14:59:59.999Z" });
    f.add({ occurred_at: "2026-09-08T15:00:00.000Z" });
    const query = "view=password&identityId=test-user&service=cloud&authMethod=password&outcome=success&eventType=password_login_success&from=2026-09-08&to=2026-09-08";
    const first = await f.query(query);
    assert.equal(first.events.length, 100);
    const second = await f.query(`${query}&cursor=${first.nextCursor}`);
    assert.deepEqual([...first.events, ...second.events].map((row) => row.event_id), ids);
    assert.equal(second.nextCursor, null);
    assert.equal((await f.query("view=password&eventType=session_resume")).events.length, 0);
    assert.equal((await f.query("view=password&authMethod=passkey")).events.length, 0);
    await assert.rejects(f.query("cursor=not-a-valid-cursor"), { status: 400 });
  } finally { f.close(); }
});
