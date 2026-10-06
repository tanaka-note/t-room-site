import { fileURLToPath } from "node:url";

// Run a local RPC fixture alongside Diary. Never deploy this configuration.
export const passkeyFixtureArgs = ["--config", fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  "--config", fileURLToPath(new URL("./fixtures/passkey-security.wrangler.json", import.meta.url))];

export function diaryFixtureLogin(request, loginId, password) {
  const accountId = ["main@example.test", "main-admin@example.test"].includes(loginId) ? "main-admin"
    : loginId === "sub@a-tanaka.jp" ? "main-user" : null;
  return accountId
    ? request("/passkey/handoff", { method: "POST", body: { handoffToken: `fixture-${accountId}` } })
    : request("/login", { method: "POST", body: { loginId, password } });
}
