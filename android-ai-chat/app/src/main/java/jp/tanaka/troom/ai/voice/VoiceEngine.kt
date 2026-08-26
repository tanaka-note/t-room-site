package jp.tanaka.troom.ai.voice

import kotlinx.coroutines.flow.StateFlow

/** Keeps the conversation UI independent from OpenAI and future VOICEVOX implementations. */
interface VoiceEngine {
    val state: StateFlow<VoiceState>
    suspend fun start(conversationId: String)
    suspend fun stop()
    suspend fun interrupt()
}

sealed interface VoiceState {
    data object Idle : VoiceState
    data object Connecting : VoiceState
    data object Listening : VoiceState
    data object Speaking : VoiceState
    data class Unavailable(val reason: String) : VoiceState
    data class Failed(val message: String) : VoiceState
}
