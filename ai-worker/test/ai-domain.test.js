import test from "node:test";
import assert from "node:assert/strict";
import {
  currentJstPeriod,
  effectiveBudgetLimitMicros,
  estimateReservationMicrosJpy,
  memoryNamespace,
  normalizedMessage,
  publicBudgetState,
  selectChatModel,
  usageCostMicrosJpy
} from "../src/ai-domain.js";

test("JST月次期間はUTC境界ではなく日本時間で切り替わる", () => {
  assert.equal(currentJstPeriod(Date.parse("2026-08-31T14:59:59Z")), "2026-08");
  assert.equal(currentJstPeriod(Date.parse("2026-08-31T15:00:00Z")), "2026-09");
});

test("Memory namespaceはuserとcharacterの両方で分離される", () => {
  assert.equal(memoryNamespace("primary-admin", "zundamon"), "primary-admin:zundamon");
  assert.notEqual(memoryNamespace("primary-admin", "zundamon"), memoryNamespace("other-user", "zundamon"));
  assert.notEqual(memoryNamespace("primary-admin", "zundamon"), memoryNamespace("primary-admin", "other-character"));
});

test("モデルルーティングは軽量・通常・高度をサーバー側で選べる", () => {
  assert.equal(selectChatModel("こんにちは"), "gpt-5.6-luna");
  assert.equal(selectChatModel("理由を比較して説明して"), "gpt-5.6-terra");
  assert.equal(selectChatModel("セキュリティ設計を詳細に分析して"), "gpt-5.6-sol");
});

test("入力検証は空文字と制御文字を拒否する", () => {
  assert.equal(normalizedMessage(" こんにちは "), "こんにちは");
  assert.equal(normalizedMessage(""), "");
  assert.equal(normalizedMessage("x\u0000y"), "");
});

test("料金予約は実績料金以上の保守的な上限になる", () => {
  const reservation = estimateReservationMicrosJpy({ model: "gpt-5.6-luna", inputText: "日本語の入力", maxOutputTokens: 900, usdJpyRate: 200 });
  const actual = usageCostMicrosJpy({ model: "gpt-5.6-luna", inputTokens: 100, cachedInputTokens: 10, outputTokens: 200, usdJpyRate: 200 });
  assert.ok(reservation > actual);
});

test("通常枠2700円と予備枠2850円をJST月単位で切り替える", () => {
  const policy = { monthlyBudgetJpy: 3000, softStopJpy: 2700, hardStopJpy: 2850, reserveEnabled: true, reservePeriod: "2026-08" };
  assert.equal(effectiveBudgetLimitMicros(policy, "2026-08"), 2_850_000_000);
  assert.equal(effectiveBudgetLimitMicros(policy, "2026-09"), 2_700_000_000);
  const state = publicBudgetState({ policy, usageMicros: 2_700_000_000, period: "2026-08" });
  assert.equal(state.stopped, false);
  assert.equal(state.remainingJpy, 150);
  assert.equal(state.activeLimitJpy, 2850);
  assert.equal(state.usageRatio, state.budgetUsageRate);
  assert.ok(state.projectedMonthEndJpy >= state.spentJpy);
});
