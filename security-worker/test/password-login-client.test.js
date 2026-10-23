import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("retired services omit password forms and client submit handlers; Security Center retains recovery", () => {
  for (const service of ["cloud", "diary", "billing"]) {
    assert.doesNotMatch(read(`${service}-worker/public/index.html`), /id="login-form"|id="login-password"|remember-login|password-login-audit\.js/);
    assert.doesNotMatch(read(`${service}-worker/public/${service}.js`), /async function (?:login|handleLogin)\(event\)|PasswordCredential/);
  }
  assert.match(read("security-worker/public/index.html"), /id="bootstrap-form"/);
  assert.match(read("security-worker/public/security.js"), /TRoomPasskeys\.bootstrap/);
});

test("billing retains the unchanged audit helper for old cached clients only", () => {
  assert.equal(read("billing-worker/public/password-login-audit.js"), read("cloud-worker/public/password-login-audit.js"));
  assert.doesNotMatch(read("billing-worker/public/billing.js"), /TRoomPasswordLoginAudit/);
});
