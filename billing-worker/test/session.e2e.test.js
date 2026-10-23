import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return {url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit:true};
  return next(specifier, context);
} });
const worker = (await import("../src/index.js")).default;

test("real billing handler rejects cached password requests without credential DB access, even when passkeys are disabled", async () => {
  const events = [];
  const env = { SESSION_SECRET: randomBytes(32).toString("hex"), PASSKEY_ENABLED: "false",
    DB: { prepare() { assert.fail("retired password requests must not access billing DB"); } },
    SECURITY: { recordAuditEvent: async event => events.push(event) } };
  for (const body of [JSON.stringify({loginId:"future-user",password:"fixture"}), "{malformed", "{}"]) {
    const response = await worker.fetch(new Request("https://example.test/billing/api/login", {method:"POST",
      headers:{Origin:"https://example.test","Content-Type":"application/json"},body}),env,{});
    assert.equal(response.status,401); assert.equal(response.headers.get("set-cookie"),null);
    assert.equal(events.at(-1).details.reason,"password_auth_disabled");
    assert.equal(events.at(-1).details.counterUpdated,false);
  }
  assert.equal(events.length,3);
});
