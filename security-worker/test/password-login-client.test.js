import test from "node:test";
import vm from "node:vm";
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

for (const service of ["diary", "downloader", "downloader2"]) {
  test(`${service} preserves the passkey icon through busy and retry states`, () => {
    const source = read(`${service}-worker/public/${service}.js`);
    const start = source.indexOf("  function setBusy(button, busy,");
    const end = source.indexOf("\n  function ", start + 1);
    const label = { textContent: "パスキーでログイン" };
    let iconPresent = true;
    const attributes = new Map();
    const button = {
      disabled: false,
      querySelector: selector => selector === ".passkey-login-label" ? label : null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      set textContent(value) { iconPresent = false; label.textContent = value; }
    };
    const context = vm.createContext({ button });
    vm.runInContext(`${source.slice(start, end)};setBusy(button, true, "確認中…");`, context);
    assert.equal(button.disabled, true);
    assert.equal(attributes.get("aria-busy"), "true");
    assert.equal(label.textContent, "確認中…");
    assert.equal(iconPresent, true);
    vm.runInContext('setBusy(button, false, "パスキーでログイン");', context);
    assert.equal(button.disabled, false);
    assert.equal(attributes.has("aria-busy"), false);
    assert.equal(label.textContent, "パスキーでログイン");
    assert.equal(iconPresent, true);
    const ordinary = { querySelector: () => null };
    context.button = ordinary;
    vm.runInContext('setBusy(button, false, "再試行");', context);
    assert.equal(ordinary.textContent, "再試行");
  });
}
