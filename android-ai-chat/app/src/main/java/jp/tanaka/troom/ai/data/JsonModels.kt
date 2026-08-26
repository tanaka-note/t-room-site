package jp.tanaka.troom.ai.data

import jp.tanaka.troom.ai.model.*
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.toSessionInfo(): SessionInfo {
    val userJson = getJSONObject("user")
    val usageJson = getJSONObject("usage")
    val budgetJson = getJSONObject("budget")
    val models = usageJson.optJSONArray("byModel") ?: JSONArray()
    return SessionInfo(
        user = UserProfile(userJson.getString("identityId"), userJson.getString("displayName"), userJson.optString("role", "user")),
        usage = UsageSummary(
            period = usageJson.optString("period"),
            inputTokens = usageJson.optLong("inputTokens"),
            cachedInputTokens = usageJson.optLong("cachedInputTokens"),
            outputTokens = usageJson.optLong("outputTokens"),
            audioInputTokens = usageJson.optLong("audioInputTokens"),
            audioOutputTokens = usageJson.optLong("audioOutputTokens"),
            totalCostJpy = usageJson.optDouble("totalCostJpy"),
            byModel = (0 until models.length()).map { index -> models.getJSONObject(index).let {
                ModelUsage(it.optString("model"), it.optLong("requests"), it.optDouble("costJpy"))
            } },
        ),
        budget = BudgetState(
            monthlyBudgetJpy = budgetJson.optInt("monthlyBudgetJpy", 3_000),
            softStopJpy = budgetJson.optInt("softStopJpy", 2_700),
            hardStopJpy = budgetJson.optInt("hardStopJpy", 2_850),
            reserveEnabled = budgetJson.optBoolean("reserveEnabled"),
            activeLimitJpy = budgetJson.optInt("activeLimitJpy", 2_700),
            remainingJpy = budgetJson.optDouble("remainingJpy", 2_700.0),
            usageRatio = budgetJson.optDouble("usageRatio"),
            projectedMonthEndJpy = budgetJson.optDouble("projectedMonthEndJpy"),
            stopped = budgetJson.optBoolean("stopped"),
        ),
    )
}

internal fun JSONObject.toConversation(): Conversation = Conversation(
    id = getString("id"),
    characterId = optString("character_id", optString("characterId", "zundamon")),
    title = optString("title", "新しい会話"),
    currentMode = if (optString("current_mode", optString("currentMode")) == "voice") ConversationMode.VOICE else ConversationMode.CHAT,
    updatedAt = optString("updated_at", optString("updatedAt")),
)

internal fun JSONObject.toMessage(): ChatMessage = ChatMessage(
    id = getString("id"),
    role = getString("role"),
    content = getString("content"),
    model = optString("model").takeIf(String::isNotBlank),
    sourceMode = if (optString("source_mode", optString("sourceMode")) == "voice") ConversationMode.VOICE else ConversationMode.CHAT,
)
