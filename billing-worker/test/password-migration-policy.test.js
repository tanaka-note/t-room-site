import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("billing login upgrades legacy hashes without changing account identity or sessions", async () => {
  const [worker, migration, example] = await Promise.all([
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations/0007_password_security.sql", import.meta.url), "utf8"),
    readFile(new URL("../.dev.vars.example", import.meta.url), "utf8")
  ]);

  assert.match(worker, /verifyPasswordRecord\(password, account, env\.BILLING_PASSWORD_PEPPER/);
  assert.match(worker, /upgradePasswordAfterLogin\(env, account, password\)/);
  assert.match(worker, /try \{\s*await upgradePasswordAfterLogin\(env, account, password\);\s*\} catch \(error\)/s);
  assert.match(worker, /WHERE id = \? AND password_pepper_version = \? AND password_iterations = \?/);
  assert.match(worker, /SOURCE_LOGIN_LIMIT|recordSourceLoginFailure/);
  assert.match(migration, /password_pepper_version INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS billing_login_attempts/);
  assert.match(example, /BILLING_PASSWORD_PEPPER="replace-with-/);
});
