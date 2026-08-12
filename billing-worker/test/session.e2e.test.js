import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const origin = "http://127.0.0.1:8797";
const testPassword = "billing-session-test";

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wranglerPath, ...args], {
    cwd: projectDirectory,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function sessionExpiry(cookie) {
  const token = cookie.split(";", 1)[0].split("=", 2)[1];
  const payload = JSON.parse(Buffer.from(token.split(".", 1)[0], "base64url").toString("utf8"));
  return payload.exp;
}

test("owner and member sessions roll forward for 30 days", async () => {
  runWrangler(["d1", "migrations", "apply", "billing-db", "--local"]);
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(testPassword, salt, 100000, 32, "sha256");
  runWrangler([
    "d1", "execute", "billing-db", "--local", "--command",
    `UPDATE billing_accounts SET password_salt = '${salt.toString("base64url")}', password_hash = '${hash.toString("base64url")}', password_iterations = 100000, failed_login_attempts = 0, locked_until = NULL WHERE id IN ('owner', 'chiharu')`
  ]);

  const server = spawn(process.execPath, [
    wranglerPath,
    "dev",
    "--local",
    "--port",
    "8797",
    "--var",
    "ALLOW_LOCAL_HTTP:true",
    "--var",
    "SESSION_SECRET:billing-session-e2e-secret"
  ], {
    cwd: projectDirectory,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });

  async function waitForServer() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${origin}/billing/api/session`);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Local billing server did not start.\n${output}`);
  }

  async function login(loginId) {
    const response = await fetch(`${origin}/billing/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ loginId, password: testPassword })
    });
    assert.equal(response.status, 200, await response.text());
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /Max-Age=2592000/);
    return cookie.split(";", 1)[0];
  }

  try {
    await waitForServer();
    for (const loginId of ["contact@a-tanaka.jp", "chiharu"]) {
      const cookie = await login(loginId);
      const firstExpiry = sessionExpiry(cookie);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const response = await fetch(`${origin}/billing/api/session`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const refreshedCookie = response.headers.get("set-cookie");
      assert.match(refreshedCookie, /Max-Age=2592000/);
      assert.ok(sessionExpiry(refreshedCookie) > firstExpiry);
    }
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
  }
});
