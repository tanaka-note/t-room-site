import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("../public/billing.js", import.meta.url), "utf8");
const handler = script.slice(script.indexOf("  async function loginWithPasskey()"), script.indexOf("  async function choosePasskeyLink"));
for (const fail of [false, true]) test(`passkey login restores loading state after ${fail ? "failure" : "success"}`, async () => {
  const button = { disabled: false, setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } };
  const label = { textContent: "パスキーでログイン" }, error = { textContent: "" }, calls = [];
  const context = { el: { "passkey-login": button, "passkey-login-label": label, "login-error": error },
    choosePasskeyLink() {},
    TRoomPasskeys: { authenticate: async service => {
      assert.equal(service, "billing"); assert.equal(button.disabled, true); assert.equal(button["aria-busy"], "true");
      assert.equal(label.textContent, "確認中…");
      if (fail) throw Error("fixture failure");
      return { handoff: { handoffToken: "fixture-token" } };
    } },
    api: async (path, options) => { calls.push(path); assert.equal(options.body.handoffToken, "fixture-token"); return {authenticated:true}; },
    enterApp: async session => { assert.equal(session.authenticated, true); calls.push("enterApp"); }
  };
  vm.createContext(context);
  await vm.runInContext(`${handler};loginWithPasskey()`, context);
  assert.equal(button.disabled, false); assert.equal(button["aria-busy"], undefined);
  assert.equal(label.textContent, "パスキーでログイン");
  assert.equal(error.textContent, fail ? "fixture failure" : "");
  assert.deepEqual(calls, fail ? [] : ["/passkey/handoff", "enterApp"]);
});
