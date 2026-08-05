import test from "node:test";
import assert from "node:assert/strict";
import { balanceEffect, monthBounds, signedDocumentAmount } from "../src/finance.js";

test("monthBounds handles ordinary months and year end", () => {
  assert.deepEqual(monthBounds("2026-08"), { start: "2026-08-01", next: "2026-09-01" });
  assert.deepEqual(monthBounds("2026-12"), { start: "2026-12-01", next: "2027-01-01" });
});

test("signedDocumentAmount applies fixed category direction", () => {
  assert.equal(signedDocumentAmount("purchase", 1000), 1000);
  assert.equal(signedDocumentAmount("discount", 350), -350);
  assert.equal(signedDocumentAmount("income", 350), -350);
  assert.equal(signedDocumentAmount("offset", 350), -350);
  assert.equal(signedDocumentAmount("other", 50, "plus"), 50);
  assert.equal(signedDocumentAmount("other", 50, "minus"), -50);
});

test("payment notices offset the account balance", () => {
  assert.equal(balanceEffect("invoice", 1000), 1000);
  assert.equal(balanceEffect("payment_notice", 1000), -1000);
});
