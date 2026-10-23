import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("retired billing login keeps legacy schema and never reads or upgrades passwords", async () => {
  const [worker, migration] = await Promise.all([
    readFile(new URL("../src/index.js", import.meta.url), "utf8"),
    readFile(new URL("../migrations/0007_password_security.sql", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(worker, /verifyPasswordRecord|upgradePasswordAfterLogin|createCurrentPasswordRecord|password_hash|password_salt/);
  assert.match(migration, /password_pepper_version INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS billing_login_attempts/);
});
