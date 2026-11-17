import { fileURLToPath } from "node:url";

// Run a legacy-schema RPC fixture alongside Diary. Keep its rollout explicit
// when production enables key preparation; encrypted fixtures build their own
// candidate schema and enable encryption separately. Never deploy this setup.
export const passkeyFixtureArgs = ["--config", fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  "--config", fileURLToPath(new URL("./fixtures/passkey-security.wrangler.json", import.meta.url)),
  "--var", "DIARY_ENCRYPTION_ENABLED:false"];

export function diaryFixtureLogin(request, loginId, password) {
  const accountId = ["main@example.test", "main-admin@example.test"].includes(loginId) ? "main-admin"
    : loginId === "sub@a-tanaka.jp" ? "main-user"
    : loginId === "wife@example.test" ? "wife-admin"
    : loginId === "giantz3031@gmail.com" ? "chiharu-admin"
    : /^[a-z0-9-]+@example\.test$/.test(loginId) ? loginId.split("@")[0] : null;
  return accountId
    ? request("/passkey/handoff", { method: "POST", body: { handoffToken: `fixture-${accountId}` } })
    : request("/login", { method: "POST", body: { loginId, password } });
}
