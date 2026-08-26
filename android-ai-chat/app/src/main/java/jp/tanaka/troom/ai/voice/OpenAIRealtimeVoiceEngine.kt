package jp.tanaka.troom.ai.voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Phase 1 boundary for foreground OpenAI Realtime WebRTC. No API key is held by
 * Android. Phase 2 supplies a short-lived client secret from the AI Worker.
 */
class OpenAIRealtimeVoiceEngine : VoiceEngine {
    private val mutableState = MutableStateFlow<VoiceState>(
        VoiceState.Unavailable("音声会話は次の開発段階で有効になります。チャットは現在ご利用いただけます。"),
    )
    override val state: StateFlow<VoiceState> = mutableState

    override suspend fun start(conversationId: String) {
        mutableState.value = VoiceState.Unavailable("Realtime接続はまだ有効化されていません。")
    }
    override suspend fun stop() { mutableState.value = VoiceState.Idle }
    override suspend fun interrupt() = Unit
}
