package jp.tanaka.troom.ai.model

data class UserProfile(
    val identityId: String,
    val displayName: String,
    val role: String,
)

data class UsageSummary(
    val period: String = "",
    val inputTokens: Long = 0,
    val cachedInputTokens: Long = 0,
    val outputTokens: Long = 0,
    val audioInputTokens: Long = 0,
    val audioOutputTokens: Long = 0,
    val totalCostJpy: Double = 0.0,
    val byModel: List<ModelUsage> = emptyList(),
)

data class ModelUsage(val model: String, val requests: Long, val costJpy: Double)

data class BudgetState(
    val monthlyBudgetJpy: Int = 3_000,
    val softStopJpy: Int = 2_700,
    val hardStopJpy: Int = 2_850,
    val reserveEnabled: Boolean = false,
    val activeLimitJpy: Int = 2_700,
    val remainingJpy: Double = 2_700.0,
    val usageRatio: Double = 0.0,
    val projectedMonthEndJpy: Double = 0.0,
    val stopped: Boolean = false,
)

data class SessionInfo(val user: UserProfile, val usage: UsageSummary, val budget: BudgetState)

data class CharacterProfile(
    val id: String,
    val displayName: String,
    val speakingStyle: String,
    val firstPerson: String,
    val userAddress: String,
    val voiceEngine: String,
)

data class Conversation(
    val id: String,
    val characterId: String,
    val title: String,
    val currentMode: ConversationMode,
    val updatedAt: String = "",
)

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val model: String? = null,
    val sourceMode: ConversationMode = ConversationMode.CHAT,
    val pending: Boolean = false,
)

enum class ConversationMode(val wireValue: String) { CHAT("chat"), VOICE("voice") }

data class PendingMessage(
    val conversationId: String,
    val clientRequestId: String,
    val content: String,
    val mode: ConversationMode,
)
