import test from "node:test";
import assert from "node:assert/strict";
import { isLoginLocked, reachesLoginLimit } from "../src/login-limit.js";

test("only the fifth consecutive password failure reaches the limit", () => {
  assert.equal(reachesLoginLimit(3), false);
  assert.equal(reachesLoginLimit(4), true);
});

test("locked timestamps are compared as UTC", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");
  assert.equal(isLoginLocked("2026-08-05 12:15:00", now), true);
  assert.equal(isLoginLocked("2026-08-05 11:59:59", now), false);
  assert.equal(isLoginLocked(null, now), false);
});
