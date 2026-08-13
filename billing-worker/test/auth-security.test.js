import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";
import {
  ACCOUNT_LOGIN_LIMIT,
  CURRENT_PASSWORD_ITERATIONS,
  CURRENT_PEPPER_VERSION,
  SOURCE_LOGIN_LIMIT,
  createCurrentPasswordRecord,
  isSourceLocked,
  needsPasswordUpgrade,
  nextSourceAttempt,
  verifyPasswordRecord
} from "../src/auth-security.js";

test("legacy billing passwords remain valid until their next successful upgrade", async () => {
  const password = "legacy-test-password";
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
  const record = {
    password_salt: salt.toString("base64url"),
    password_hash: hash.toString("base64url"),
    password_iterations: 100000,
    password_pepper_version: 0
  };

  assert.equal(await verifyPasswordRecord(password, record), true);
  assert.equal(await verifyPasswordRecord("wrong", record), false);
  assert.equal(needsPasswordUpgrade(record), true);
});

test("current billing passwords use the server pepper and 600000 PBKDF2 iterations", async () => {
  const password = "current-test-password";
  const pepper = "test-only-billing-pepper-that-is-not-used-in-production";
  const created = await createCurrentPasswordRecord(password, pepper);
  const record = {
    password_salt: created.passwordSalt,
    password_hash: created.passwordHash,
    password_iterations: created.passwordIterations,
    password_pepper_version: created.passwordPepperVersion
  };

  assert.equal(created.passwordIterations, CURRENT_PASSWORD_ITERATIONS);
  assert.equal(created.passwordPepperVersion, CURRENT_PEPPER_VERSION);
  assert.equal(await verifyPasswordRecord(password, record, pepper), true);
  assert.equal(await verifyPasswordRecord(password, record, "wrong-pepper"), false);
  assert.equal(await verifyPasswordRecord(password, record, ""), false);
  assert.equal(needsPasswordUpgrade(record), false);
});

test("the fifth failure locks only the matching source fingerprint", () => {
  const now = 1000000;
  let attempt = null;
  for (let count = 1; count <= SOURCE_LOGIN_LIMIT; count += 1) {
    attempt = nextSourceAttempt(attempt, now + count);
    assert.equal(attempt.failedCount, count);
  }
  assert.equal(isSourceLocked(attempt.lockedUntil, now + SOURCE_LOGIN_LIMIT), true);
  assert.equal(isSourceLocked(attempt.lockedUntil, attempt.lockedUntil), false);
});

test("the account-wide emergency limit is higher than the ordinary source limit", () => {
  assert.equal(SOURCE_LOGIN_LIMIT, 5);
  assert.equal(ACCOUNT_LOGIN_LIMIT, 25);
});
