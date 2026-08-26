package jp.tanaka.troom.ai.data

import jp.tanaka.troom.ai.model.ConversationMode
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class JsonModelsTest {
    @Test
    fun sessionUsageAndServerBudgetAreParsedWithoutClientOverrides() {
        val session = JSONObject("""{
          "user":{"identityId":"primary-admin","displayName":"田中宏知","role":"admin"},
          "usage":{"period":"2026-08","inputTokens":120,"cachedInputTokens":20,"outputTokens":40,"audioInputTokens":0,"audioOutputTokens":0,"totalCostJpy":12.5,"byModel":[{"model":"gpt-5.6-luna","requests":2,"costJpy":12.5}]},
          "budget":{"monthlyBudgetJpy":3000,"softStopJpy":2700,"hardStopJpy":2850,"reserveEnabled":false,"activeLimitJpy":2700,"remainingJpy":2687.5,"usageRatio":0.0041,"projectedMonthEndJpy":16.2,"stopped":false}
        }""").toSessionInfo()
        assertEquals("primary-admin", session.user.identityId)
        assertEquals(20, session.usage.cachedInputTokens)
        assertEquals(2_700, session.budget.activeLimitJpy)
        assertFalse(session.budget.reserveEnabled)
        assertFalse(session.budget.stopped)
    }

    @Test
    fun conversationModeCanMoveBetweenChatAndVoiceInOneConversation() {
        val chat = JSONObject("""{"id":"c1","characterId":"zundamon","title":"会話","currentMode":"chat"}""").toConversation()
        val voice = JSONObject("""{"id":"c1","character_id":"zundamon","title":"会話","current_mode":"voice"}""").toConversation()
        assertEquals(chat.id, voice.id)
        assertEquals(ConversationMode.CHAT, chat.currentMode)
        assertEquals(ConversationMode.VOICE, voice.currentMode)
    }
}
