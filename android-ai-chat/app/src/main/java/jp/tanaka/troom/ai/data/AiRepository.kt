package jp.tanaka.troom.ai.data

import jp.tanaka.troom.ai.model.*
import org.json.JSONObject
import java.util.UUID

data class PasskeyOptions(val challengeId: String, val requestJson: String)

class AiRepository(
    private val http: AiHttpClient,
    private val secureStore: SecureSessionStore,
) {
    suspend fun requestPasskeyOptions(): PasskeyOptions {
        val result = http.post("/security/api/auth/options", JSONObject().put("service", "ai"))
        return PasskeyOptions(result.body.getString("challengeId"), result.body.getJSONObject("options").toString())
    }

    suspend fun completePasskeyLogin(options: PasskeyOptions, authenticationResponseJson: String): SessionInfo {
        val verified = http.post("/security/api/auth/verify", JSONObject()
            .put("service", "ai")
            .put("challengeId", options.challengeId)
            .put("response", JSONObject(authenticationResponseJson)))
        val identityCookie = verified.cookies.firstOrNull { it.startsWith("troom_security_identity=") }
            ?: throw ApiException(401, "Security Centerの認証セッションを確認できませんでした。")
        val links = verified.body.optJSONArray("links")
        if (links == null || links.length() != 1) throw ApiException(409, "AI Chatのサービス連携を確認してください。")
        val handoff = http.post("/security/api/auth/handoff", JSONObject()
            .put("service", "ai")
            .put("linkId", links.getJSONObject(0).getString("id")), identityCookie)
        val completed = http.post("/ai/api/passkey/handoff", JSONObject()
            .put("handoffToken", handoff.body.getString("handoffToken")))
        val aiCookie = completed.cookies.firstOrNull { it.startsWith("troom_ai_session=") }
            ?: throw ApiException(401, "AI Chatのログインセッションを開始できませんでした。")
        secureStore.saveSessionCookie(aiCookie)
        return session()
    }

    suspend fun session(): SessionInfo {
        val cookie = requireCookie()
        return http.get("/ai/api/session", cookie).body.toSessionInfo()
    }

    suspend fun logout() {
        secureStore.readSessionCookie()?.let { runCatching { http.post("/ai/api/logout", JSONObject(), it) } }
        secureStore.clearSession()
        secureStore.clearPending()
    }

    suspend fun characters(): List<CharacterProfile> {
        val values = http.get("/ai/api/characters", requireCookie()).body.getJSONArray("characters")
        return (0 until values.length()).map { index -> values.getJSONObject(index).let {
            CharacterProfile(
                id = it.getString("id"),
                displayName = it.getString("display_name"),
                speakingStyle = it.optString("speaking_style"),
                firstPerson = it.optString("first_person"),
                userAddress = it.optString("user_address"),
                voiceEngine = it.optString("voice_engine"),
            )
        } }
    }

    suspend fun conversations(): List<Conversation> {
        val values = http.get("/ai/api/conversations", requireCookie()).body.getJSONArray("conversations")
        return (0 until values.length()).map { values.getJSONObject(it).toConversation() }
    }

    suspend fun createConversation(mode: ConversationMode): Conversation {
        val response = http.post("/ai/api/conversations", JSONObject()
            .put("characterId", "zundamon").put("mode", mode.wireValue), requireCookie())
        return response.body.getJSONObject("conversation").toConversation()
    }

    suspend fun conversation(id: String): Pair<Conversation, List<ChatMessage>> {
        val body = http.get("/ai/api/conversations/$id", requireCookie()).body
        val messages = body.getJSONArray("messages")
        return body.getJSONObject("conversation").toConversation() to
            (0 until messages.length()).map { messages.getJSONObject(it).toMessage() }
    }

    suspend fun send(
        conversationId: String,
        content: String,
        mode: ConversationMode = ConversationMode.CHAT,
        clientRequestId: String = UUID.randomUUID().toString(),
    ): ChatMessage {
        val pending = PendingMessage(conversationId, clientRequestId, content, mode)
        secureStore.savePending(pending)
        val result = http.post("/ai/api/conversations/$conversationId/messages", JSONObject()
            .put("clientRequestId", clientRequestId)
            .put("content", content)
            .put("mode", mode.wireValue), requireCookie())
        secureStore.clearPending()
        return result.body.getJSONObject("message").toMessage()
    }

    fun pendingMessage(): PendingMessage? = secureStore.readPending()

    private fun requireCookie(): String = secureStore.readSessionCookie()
        ?: throw ApiException(401, "パスキーでログインしてください。")
}
