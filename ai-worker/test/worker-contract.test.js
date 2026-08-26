import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../migrations/0001_ai_chat_foundation.sql", import.meta.url), "utf8");
const ownerGuards = fs.readFileSync(new URL("../migrations/0002_conversation_owner_guards.sql", import.meta.url), "utf8");

test("Androidから送られたidentityやbudgetを認可の正本にしない", () => {
  assert.match(source, /redeemHandoff\([\s\S]*"ai"/);
  assert.match(source, /getAiBudgetPolicy\(identityId\)/);
  assert.doesNotMatch(source, /body\.(?:identityId|monthlyBudget|softStop|hardStop)/);
});

test("Passkey sessionは毎回Securityで失効検証する", () => {
  assert.match(source, /validatePasskeySession\(\{/);
  assert.match(source, /service: "ai"/);
  assert.match(source, /passkeySessionEpoch/);
});

test("会話とMemoryはIdentityかつCharacterで分離する", () => {
  assert.match(migration, /ai_conversations[\s\S]*identity_id TEXT NOT NULL[\s\S]*character_id TEXT NOT NULL/);
  assert.match(migration, /ai_memories[\s\S]*identity_id TEXT NOT NULL[\s\S]*character_id TEXT NOT NULL/);
  assert.match(migration, /UNIQUE \(identity_id, client_message_id\)/);
  for (const table of ["ai_messages", "ai_memories", "ai_usage_events", "ai_request_claims"]) {
    assert.match(ownerGuards, new RegExp(`(?:BEFORE INSERT ON ${table})[\\s\\S]*identity_id = NEW\\.identity_id[\\s\\S]*character_id = NEW\\.character_id`));
  }
});

test("API keyと会話本文を監査へ保存しない", () => {
  assert.doesNotMatch(source, /recordAuditEvent\([\s\S]{0,300}content:/);
  assert.match(source, /env\.OPENAI_API_KEY/);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]/);
});

test("予算予約失敗もrequest claimを安全に終了し、再送時は保存済みuser message IDを再利用する", () => {
  assert.match(source, /let reservationAcquired = false/);
  assert.match(source, /reservationAcquired \? reservation : 0/);
  assert.match(source, /failedChargeMicros = reservation/);
  assert.match(source, /spent_micros_jpy = spent_micros_jpy \+ \?/);
  assert.match(source, /SELECT id, content FROM ai_messages/);
  assert.match(source, /storedUserMessage\.id/);
});

test("OpenAI安全識別子は会話本文ではなくserver-side saltと認証Identityから作る", () => {
  assert.match(source, /privacyPreservingIdentifier\(identityId, env\)/);
  assert.match(source, /AI_SAFETY_SALT \|\| env\.SESSION_SECRET/);
  assert.doesNotMatch(source, /privacyPreservingIdentifier\(history\)/);
});
