import { WorkerEntrypoint } from "cloudflare:workers";
import {
  currentJstPeriod,
  effectiveBudgetLimitMicros,
  estimateReservationMicrosJpy,
  memoryNamespace,
  normalizedIdentifier,
  normalizedMessage,
  publicBudgetState,
  selectChatModel,
  usageCostMicrosJpy
} from "./ai-domain.js";

const BASE_PATH = "/ai";
const SESSION_COOKIE = "troom_ai_session";
const encoder = new TextEncoder();

export default class AiWorker extends WorkerEntrypoint {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(BASE_PATH)) return json({ error: "指定された情報が見つかりません。" }, 404);
      const path = url.pathname.slice(BASE_PATH.length) || "/";
      if (!path.startsWith("/api/")) return json({ error: "AI ChatはAndroidアプリからご利用ください。" }, 404);
      return await handleApi(request, this.env, url, path, this.ctx);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(JSON.stringify({ event: "ai_request_failed", error: safeErrorName(error) }));
      return json({ error: status === 500 ? "AI Chatで処理を完了できませんでした。" : error.message }, status);
    }
  }
}

export class SecurityIntegration extends WorkerEntrypoint {
  async listLinkTargets() {
    return {
      service: "ai",
      displayName: "AI Chat",
      targets: [{
        accountId: "owner",
        displayLabel: "AI Chat By T-ROOM",
        role: "admin",
        roleLabel: "AI利用者",
        privileged: false,
        exclusive: false,
        shared: true,
        rootFolderId: null
      }]
    };
  }

  async describeAccount(input) {
    return String(input?.accountId || "") === "owner"
      ? { valid: true, ...(await this.listLinkTargets()).targets[0] }
      : { valid: false };
  }

  async getUsageSummary(identityId) {
    const identity = normalizedIdentifier(identityId, 64);
    if (!identity) return null;
    return usageSummary(this.env, identity);
  }
}

async function handleApi(request, env, url, path, context) {
  if (path === "/api/passkey/handoff" && request.method === "POST") {
    requireMutation(request, url);
    return completePasskeyHandoff(request, env, url);
  }
  const session = await requireSession(request, env);
  if (path === "/api/session" && request.method === "GET") return sessionResponse(env, session);
  if (path === "/api/logout" && request.method === "POST") {
    requireMutation(request, url);
    scheduleAudit(context, audit(env, request, session, "logout", "success"));
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(url.protocol === "https:") });
  }
  if (path === "/api/characters" && request.method === "GET") return listCharacters(env, session);
  if (path === "/api/conversations" && request.method === "GET") return listConversations(env, session);
  if (path === "/api/conversations" && request.method === "POST") {
    requireMutation(request, url);
    return createConversation(request, env, session);
  }
  const conversationMatch = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]{1,128})$/);
  if (conversationMatch && request.method === "GET") return conversationDetail(env, session, conversationMatch[1]);
  const messageMatch = path.match(/^\/api\/conversations\/([A-Za-z0-9_-]{1,128})\/messages$/);
  if (messageMatch && request.method === "POST") {
    requireMutation(request, url);
    return sendMessage(request, env, session, messageMatch[1]);
  }
  throw new HttpError(404, "指定された情報が見つかりません。");
}

async function completePasskeyHandoff(request, env, url) {
  if (!env.SECURITY) throw new HttpError(503, "認証基盤へ接続できません。");
  const body = await readJson(request, 4096);
  const handoff = await env.SECURITY.redeemHandoff(String(body.handoffToken || ""), "ai");
  if (!handoff || handoff.serviceAccountId !== "owner") throw new HttpError(401, "パスキー認証の有効期限が切れています。もう一度お試しください。");
  const displayName = handoff.identityId === "primary-admin" ? "田中宏知" : (handoff.identityDisplayName || "AI Chat利用者");
  const accountRole = handoff.identityId === "primary-admin" ? "admin" : "user";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_accounts (identity_id, display_name, role, status)
      VALUES (?, ?, ?, 'active')
      ON CONFLICT(identity_id) DO UPDATE SET display_name = excluded.display_name, role = excluded.role,
        status = 'active', updated_at = CURRENT_TIMESTAMP`)
      .bind(handoff.identityId, displayName, accountRole),
    env.DB.prepare(`INSERT INTO ai_character_settings (identity_id, character_id, memory_namespace)
      VALUES (?, 'zundamon', ?) ON CONFLICT(identity_id, character_id) DO NOTHING`)
      .bind(handoff.identityId, memoryNamespace(handoff.identityId, "zundamon"))
  ]);
  const payload = {
    identityId: handoff.identityId,
    credentialId: handoff.credentialId,
    serviceLinkId: handoff.serviceLinkId,
    serviceAccountId: handoff.serviceAccountId,
    passkeySessionEpoch: handoff.sessionEpoch,
    authMethod: "passkey",
    sessionId: crypto.randomUUID(),
    expiresAt: nowSeconds() + sessionTtl(env)
  };
  const token = await signSession(payload, env);
  await audit(env, request, payload, "passkey_login_success", "success");
  return json({ authenticated: true, displayName, identityId: handoff.identityId }, 200, {
    "Set-Cookie": sessionCookie(token, sessionTtl(env), url.protocol === "https:")
  });
}

async function sessionResponse(env, session) {
  const account = await requireAccount(env, session.identityId);
  const usage = await usageSummary(env, session.identityId);
  const policy = await requireBudgetPolicy(env, session.identityId);
  return json({ authenticated: true, user: { identityId: account.identity_id, displayName: account.display_name, role: account.role }, usage, budget: publicBudgetState({ policy, usageMicros: usage.totalCostMicrosJpy }) });
}

async function listCharacters(env, session) {
  const rows = await env.DB.prepare(`SELECT c.id, c.display_name, c.speaking_style, c.first_person, c.user_address, c.voice_engine, c.voice_id,
      s.settings_json FROM ai_characters c
      JOIN ai_character_settings s ON s.character_id = c.id AND s.identity_id = ?
      WHERE c.active = 1 ORDER BY c.created_at`).bind(session.identityId).all();
  return json({ characters: rows.results || [] });
}

async function listConversations(env, session) {
  const rows = await env.DB.prepare(`SELECT id, character_id, title, current_mode, status, created_at, updated_at
    FROM ai_conversations WHERE identity_id = ? ORDER BY updated_at DESC LIMIT 100`).bind(session.identityId).all();
  return json({ conversations: rows.results || [] });
}

async function createConversation(request, env, session) {
  const body = await readJson(request, 8192);
  const characterId = normalizedIdentifier(body.characterId || "zundamon", 64);
  const mode = body.mode === "voice" ? "voice" : "chat";
  const character = await env.DB.prepare(`SELECT c.id FROM ai_characters c JOIN ai_character_settings s
    ON s.character_id = c.id WHERE c.id = ? AND c.active = 1 AND s.identity_id = ?`).bind(characterId, session.identityId).first();
  if (!character) throw new HttpError(404, "キャラクターを利用できません。");
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO ai_conversations (id, identity_id, character_id, current_mode)
    VALUES (?, ?, ?, ?)`).bind(id, session.identityId, characterId, mode).run();
  return json({ conversation: { id, characterId, title: "新しい会話", currentMode: mode } }, 201);
}

async function conversationDetail(env, session, conversationId) {
  const conversation = await ownedConversation(env, session.identityId, conversationId);
  const messages = await env.DB.prepare(`SELECT id, role, content, content_format, source_mode, model, created_at
    FROM ai_messages WHERE identity_id = ? AND conversation_id = ? ORDER BY created_at, id LIMIT 500`)
    .bind(session.identityId, conversation.id).all();
  return json({ conversation, messages: messages.results || [] });
}

async function sendMessage(request, env, session, conversationId) {
  const body = await readJson(request, 30000);
  const text = normalizedMessage(body.content);
  const clientRequestId = normalizedIdentifier(body.clientRequestId, 128);
  const sourceMode = body.mode === "voice" ? "voice" : "chat";
  if (!text || !clientRequestId) throw new HttpError(400, "メッセージを確認してください。");
  const conversation = await ownedConversation(env, session.identityId, conversationId);
  const completed = await completedClaim(env, session.identityId, clientRequestId);
  if (completed) return json(completed);
  const model = selectChatModel(text, {
    default: env.CHAT_MODEL_DEFAULT,
    balanced: env.CHAT_MODEL_BALANCED,
    advanced: env.CHAT_MODEL_ADVANCED
  });
  const claim = await claimRequest(env, { clientRequestId, identityId: session.identityId, conversation, model });
  if (!claim) throw new HttpError(409, "同じメッセージを処理中です。少し待ってから再試行してください。");
  const character = await env.DB.prepare("SELECT * FROM ai_characters WHERE id = ? AND active = 1").bind(conversation.character_id).first();
  const historyRows = await env.DB.prepare(`SELECT role, content FROM ai_messages
    WHERE identity_id = ? AND conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`)
    .bind(session.identityId, conversation.id).all();
  const history = [...(historyRows.results || [])].reverse();
  const maxOutputTokens = clampNumber(env.MAX_OUTPUT_TOKENS, 128, 2048, 900);
  const reservation = estimateReservationMicrosJpy({
    model,
    inputText: `${character.persona_instructions}\n${history.map((item) => `${item.role}:${item.content}`).join("\n")}\nuser:${text}`,
    maxOutputTokens,
    usdJpyRate: clampNumber(env.USD_JPY_SAFETY_RATE, 100, 400, 200)
  });
  const policy = await requireBudgetPolicy(env, session.identityId);
  const period = currentJstPeriod();
  let reservationAcquired = false;
  let failedChargeMicros = 0;
  try {
    await reserveBudget(env, session.identityId, period, reservation, effectiveBudgetLimitMicros(policy, period));
    reservationAcquired = true;
    const proposedUserMessageId = crypto.randomUUID();
    await env.DB.prepare(`INSERT OR IGNORE INTO ai_messages
      (id, conversation_id, identity_id, character_id, role, content, source_mode, client_message_id)
      VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`)
      .bind(proposedUserMessageId, conversation.id, session.identityId, conversation.character_id, text, sourceMode, clientRequestId).run();
    const storedUserMessage = await env.DB.prepare(`SELECT id, content FROM ai_messages
      WHERE identity_id = ? AND client_message_id = ? AND role = 'user'`)
      .bind(session.identityId, clientRequestId).first();
    if (!storedUserMessage || storedUserMessage.content !== text) throw new HttpError(409, "同じ送信IDに異なる内容が指定されています。新しいメッセージとして送信してください。");
    await env.DB.prepare(`UPDATE ai_request_claims SET reserved_micros_jpy = ?, user_message_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE client_request_id = ? AND identity_id = ?`).bind(reservation, storedUserMessage.id, clientRequestId, session.identityId).run();
    const response = await generateResponse(env, { identityId: session.identityId, model, character, history: [...history, { role: "user", content: text }], maxOutputTokens });
    // Once the provider returned a response, its charge may already exist even
    // if the following D1 transaction fails. Never release that reservation.
    failedChargeMicros = reservation;
    const cost = usageCostMicrosJpy({ ...response.usage, model, usdJpyRate: clampNumber(env.USD_JPY_SAFETY_RATE, 100, 400, 200) });
    failedChargeMicros = Math.max(reservation, cost);
    if (cost > reservation) throw new HttpError(503, "安全な料金計算を確認できなかったため、応答を保存しませんでした。");
    const assistantMessageId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ai_messages
        (id, conversation_id, identity_id, character_id, role, content, source_mode, model,
         input_tokens, cached_input_tokens, output_tokens, audio_input_tokens, audio_output_tokens)
        VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(assistantMessageId, conversation.id, session.identityId, conversation.character_id, response.text, sourceMode, model,
          response.usage.inputTokens, response.usage.cachedInputTokens, response.usage.outputTokens, response.usage.audioInputTokens, response.usage.audioOutputTokens),
      env.DB.prepare(`INSERT INTO ai_usage_events
        (request_id, identity_id, character_id, conversation_id, model, input_tokens, cached_input_tokens, output_tokens,
         audio_input_tokens, audio_output_tokens, estimated_cost_micros_jpy, usage_period, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(clientRequestId, session.identityId, conversation.character_id, conversation.id, model,
          response.usage.inputTokens, response.usage.cachedInputTokens, response.usage.outputTokens,
          response.usage.audioInputTokens, response.usage.audioOutputTokens, cost, period, occurredAt),
      env.DB.prepare(`UPDATE ai_budget_guards SET reserved_micros_jpy = MAX(0, reserved_micros_jpy - ?),
        spent_micros_jpy = spent_micros_jpy + ?, updated_at = CURRENT_TIMESTAMP WHERE identity_id = ? AND usage_period = ?`)
        .bind(reservation, cost, session.identityId, period),
      env.DB.prepare(`UPDATE ai_request_claims SET status = 'completed', reserved_micros_jpy = 0, assistant_message_id = ?,
        updated_at = CURRENT_TIMESTAMP WHERE client_request_id = ? AND identity_id = ?`)
        .bind(assistantMessageId, clientRequestId, session.identityId),
      env.DB.prepare(`UPDATE ai_conversations SET title = CASE WHEN title = '新しい会話' THEN ? ELSE title END,
        current_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND identity_id = ?`)
        .bind(text.slice(0, 40), sourceMode, conversation.id, session.identityId)
    ]);
    await audit(env, request, session, "ai_response_completed", "success", { model, costMicrosJpy: cost });
    return json({ message: { id: assistantMessageId, role: "assistant", content: response.text, model }, usage: response.usage, budget: publicBudgetState({ policy, usageMicros: (await usageSummary(env, session.identityId)).totalCostMicrosJpy }) });
  } catch (error) {
    await releaseFailedRequest(env, session.identityId, clientRequestId, period,
      reservationAcquired ? reservation : 0, failedChargeMicros, error);
    throw error;
  }
}

async function claimRequest(env, input) {
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO ai_request_claims
    (client_request_id, identity_id, conversation_id, character_id, status, model)
    VALUES (?, ?, ?, ?, 'processing', ?)`)
    .bind(input.clientRequestId, input.identityId, input.conversation.id, input.conversation.character_id, input.model).run();
  if (inserted.meta?.changes === 1) return true;
  const retry = await env.DB.prepare(`UPDATE ai_request_claims SET status = 'processing', model = ?, attempt_count = attempt_count + 1,
    error_code = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE client_request_id = ? AND identity_id = ? AND status = 'failed'`)
    .bind(input.model, input.clientRequestId, input.identityId).run();
  return retry.meta?.changes === 1;
}

async function completedClaim(env, identityId, clientRequestId) {
  const row = await env.DB.prepare(`SELECT m.id, m.role, m.content, m.model FROM ai_request_claims c
    JOIN ai_messages m ON m.id = c.assistant_message_id
    WHERE c.client_request_id = ? AND c.identity_id = ? AND c.status = 'completed'`)
    .bind(clientRequestId, identityId).first();
  return row ? { message: row, replayed: true } : null;
}

async function reserveBudget(env, identityId, period, reservation, limit) {
  await env.DB.prepare(`INSERT INTO ai_budget_guards (identity_id, usage_period, spent_micros_jpy, reserved_micros_jpy)
    VALUES (?, ?, COALESCE((SELECT SUM(estimated_cost_micros_jpy) FROM ai_usage_events WHERE identity_id = ? AND usage_period = ?), 0), 0)
    ON CONFLICT(identity_id) DO NOTHING`).bind(identityId, period, identityId, period).run();
  await env.DB.prepare(`UPDATE ai_budget_guards SET
    spent_micros_jpy = COALESCE((SELECT SUM(estimated_cost_micros_jpy) FROM ai_usage_events WHERE identity_id = ? AND usage_period = ?), 0),
    reserved_micros_jpy = 0, usage_period = ?, updated_at = CURRENT_TIMESTAMP
    WHERE identity_id = ? AND usage_period != ?`).bind(identityId, period, period, identityId, period).run();
  const update = await env.DB.prepare(`UPDATE ai_budget_guards SET reserved_micros_jpy = reserved_micros_jpy + ?, updated_at = CURRENT_TIMESTAMP
    WHERE identity_id = ? AND usage_period = ? AND spent_micros_jpy + reserved_micros_jpy + ? <= ?`)
    .bind(reservation, identityId, period, reservation, limit).run();
  if (update.meta?.changes !== 1) throw new HttpError(402, "今月のAI利用安全上限に達したため、新しいAI処理を停止しました。過去の会話と利用状況は引き続き確認できます。");
}

async function releaseFailedRequest(env, identityId, requestId, period, reservation, failedCharge, error) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE ai_budget_guards SET reserved_micros_jpy = MAX(0, reserved_micros_jpy - ?),
      spent_micros_jpy = spent_micros_jpy + ?, updated_at = CURRENT_TIMESTAMP
      WHERE identity_id = ? AND usage_period = ?`)
      .bind(reservation, Math.max(0, failedCharge), identityId, period),
    env.DB.prepare(`UPDATE ai_request_claims SET status = 'failed', reserved_micros_jpy = 0, error_code = ?, updated_at = CURRENT_TIMESTAMP
      WHERE client_request_id = ? AND identity_id = ? AND status = 'processing'`)
      .bind(error instanceof HttpError ? `http_${error.status}` : "provider_error", requestId, identityId)
  ]);
}

async function generateResponse(env, { identityId, model, character, history, maxOutputTokens }) {
  const mode = String(env.AI_PROVIDER_MODE || "disabled");
  if (mode === "mock") return {
    text: `受け取った内容を確認しました。${history.at(-1)?.content || ""}`,
    usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 20, audioInputTokens: 0, audioOutputTokens: 0 }
  };
  if (mode !== "openai" || !env.OPENAI_API_KEY) throw new HttpError(503, "AI接続はまだ有効化されていません。過去の会話と利用状況は確認できます。");
  const base = String(env.AI_GATEWAY_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const safetyIdentifier = await privacyPreservingIdentifier(identityId, env);
  const response = await fetch(`${base}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      safety_identifier: safetyIdentifier,
      prompt_cache_key: safetyIdentifier,
      instructions: character.persona_instructions,
      input: history.map((item) => ({ role: item.role, content: item.content })),
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: model.endsWith("luna") ? "none" : "low" }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(JSON.stringify({ event: "openai_request_rejected", status: response.status, type: payload?.error?.type || "unknown" }));
    throw new HttpError(503, "AIから応答を取得できませんでした。時間を置いてもう一度お試しください。");
  }
  const outputText = String(payload.output_text || "") || (payload.output || []).flatMap((item) => item.content || []).map((item) => item.text || "").join("");
  if (!outputText) throw new HttpError(503, "AIの応答を確認できませんでした。もう一度お試しください。");
  const usage = payload.usage || {};
  return {
    text: outputText,
    usage: {
      inputTokens: Number(usage.input_tokens || 0),
      cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
      outputTokens: Number(usage.output_tokens || 0),
      audioInputTokens: 0,
      audioOutputTokens: 0
    }
  };
}

async function privacyPreservingIdentifier(identityId, env) {
  const material = `${env.AI_SAFETY_SALT || env.SESSION_SECRET || "t-room-ai"}:${identityId}`;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(material))));
}

async function ownedConversation(env, identityId, id) {
  const normalized = normalizedIdentifier(id, 128);
  const row = normalized ? await env.DB.prepare(`SELECT id, identity_id, character_id, title, current_mode, status, created_at, updated_at
    FROM ai_conversations WHERE id = ? AND identity_id = ?`).bind(normalized, identityId).first() : null;
  if (!row) throw new HttpError(404, "会話が見つかりません。");
  return row;
}

async function requireSession(request, env) {
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  const session = await verifySession(token, env);
  if (!session) throw new HttpError(401, "パスキーでログインしてください。");
  const valid = await env.SECURITY?.validatePasskeySession({
    service: "ai",
    identityId: session.identityId,
    credentialId: session.credentialId,
    serviceLinkId: session.serviceLinkId,
    serviceAccountId: session.serviceAccountId,
    sessionEpoch: session.passkeySessionEpoch
  });
  if (valid?.valid !== true) throw new HttpError(401, "パスキーセッションの有効期限が切れました。もう一度ログインしてください。");
  return session;
}

async function requireAccount(env, identityId) {
  const row = await env.DB.prepare("SELECT * FROM ai_accounts WHERE identity_id = ? AND status = 'active'").bind(identityId).first();
  if (!row) throw new HttpError(403, "AI Chatアカウントを利用できません。");
  return row;
}

async function requireBudgetPolicy(env, identityId) {
  const policy = await env.SECURITY?.getAiBudgetPolicy(identityId);
  if (!policy || !Number.isFinite(Number(policy.monthlyBudgetJpy))) throw new HttpError(503, "AI利用予算を確認できないため、安全のためAI処理を停止しました。");
  return policy;
}

async function usageSummary(env, identityId) {
  const period = currentJstPeriod();
  const [total, models] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(audio_input_tokens), 0) AS audioInputTokens,
      COALESCE(SUM(audio_output_tokens), 0) AS audioOutputTokens,
      COALESCE(SUM(estimated_cost_micros_jpy), 0) AS totalCostMicrosJpy
      FROM ai_usage_events WHERE identity_id = ? AND usage_period = ?`).bind(identityId, period).first(),
    env.DB.prepare(`SELECT model, COUNT(*) AS requests, COALESCE(SUM(estimated_cost_micros_jpy), 0) AS costMicrosJpy
      FROM ai_usage_events WHERE identity_id = ? AND usage_period = ? GROUP BY model ORDER BY costMicrosJpy DESC`).bind(identityId, period).all()
  ]);
  return {
    period,
    inputTokens: Number(total?.inputTokens || 0),
    cachedInputTokens: Number(total?.cachedInputTokens || 0),
    outputTokens: Number(total?.outputTokens || 0),
    audioInputTokens: Number(total?.audioInputTokens || 0),
    audioOutputTokens: Number(total?.audioOutputTokens || 0),
    totalCostMicrosJpy: Number(total?.totalCostMicrosJpy || 0),
    totalCostJpy: Number(total?.totalCostMicrosJpy || 0) / 1_000_000,
    byModel: (models.results || []).map((row) => ({ model: row.model, requests: Number(row.requests), costJpy: Number(row.costMicrosJpy) / 1_000_000 }))
  };
}

async function audit(env, request, session, eventType, outcome, details = {}) {
  try {
    await env.SECURITY?.recordAuditEvent({
      service: "ai", eventType, outcome, identityId: session.identityId,
      serviceLinkId: session.serviceLinkId, serviceAccountId: session.serviceAccountId,
      role: session.identityId === "primary-admin" ? "admin" : "user", authMethod: "passkey", sessionId: session.sessionId,
      userAgent: request.headers.get("User-Agent"), details
    });
  } catch { /* audit transport is best effort; usage accounting remains in AI D1 */ }
}

function scheduleAudit(context, promise) { if (context?.waitUntil) context.waitUntil(promise); else void promise.catch(() => {}); }
function requireMutation(request, url) { if (request.headers.get("Origin") !== url.origin || !String(request.headers.get("Content-Type") || "").startsWith("application/json")) throw new HttpError(403, "不正なリクエストです。"); }
function sessionTtl(env) { return clampNumber(env.SESSION_TTL_SECONDS, 300, 2592000, 2592000); }
function sessionCookie(token, maxAge, secure) { return `${SESSION_COOKIE}=${token}; Path=${BASE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
function clearCookie(secure) { return `${SESSION_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`; }
async function signSession(payload, env) { if (!env.SESSION_SECRET) throw new HttpError(503, "AI Chatのセッション設定が未完了です。"); const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload))); return `${encoded}.${await hmac(encoded, env.SESSION_SECRET)}`; }
async function verifySession(token, env) { if (!token || !env.SESSION_SECRET || token.split(".").length !== 2) return null; try { const [payload, signature] = token.split("."); if (!(await safeEqual(signature, await hmac(payload, env.SESSION_SECRET)))) return null; const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))); return value.authMethod === "passkey" && Number(value.expiresAt) > nowSeconds() ? value : null; } catch { return null; } }
async function hmac(value, secret) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)))); }
async function safeEqual(left, right) { let a; let b; try { a = base64UrlToBytes(left); b = base64UrlToBytes(right); } catch { return false; } if (a.length !== b.length) return false; let result = 0; for (let i = 0; i < a.length; i += 1) result |= a[i] ^ b[i]; return result === 0; }
function bytesToBase64Url(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function base64UrlToBytes(value) { const text = String(value || ""); if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error("invalid base64url"); const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="); return Uint8Array.from(atob(base64), (item) => item.charCodeAt(0)); }
function parseCookies(header) { return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => { const index = part.indexOf("="); return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)]; })); }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function json(value, status = 200, inputHeaders) { const headers = new Headers(inputHeaders); headers.set("Content-Type", "application/json; charset=utf-8"); headers.set("Cache-Control", "no-store"); return new Response(JSON.stringify(value), { status, headers }); }
async function readJson(request, max) { const size = Number(request.headers.get("Content-Length") || 0); if (size > max) throw new HttpError(413, "入力内容が大きすぎます。"); try { const body = await request.json(); return body && typeof body === "object" ? body : {}; } catch { throw new HttpError(400, "入力内容を読み取れませんでした。"); } }
function safeErrorName(error) { return error instanceof Error ? `${error.name}:${String(error.message || "").slice(0, 120)}` : "unknown"; }

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
