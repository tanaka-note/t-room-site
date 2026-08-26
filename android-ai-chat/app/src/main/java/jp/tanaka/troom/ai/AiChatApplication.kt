package jp.tanaka.troom.ai

import android.app.Application
import jp.tanaka.troom.ai.data.AiHttpClient
import jp.tanaka.troom.ai.data.AiRepository
import jp.tanaka.troom.ai.data.SecureSessionStore
import jp.tanaka.troom.ai.voice.OpenAIRealtimeVoiceEngine

class AiChatApplication : Application() {
    lateinit var repository: AiRepository
        private set
    val voiceEngine by lazy { OpenAIRealtimeVoiceEngine() }

    override fun onCreate() {
        super.onCreate()
        repository = AiRepository(AiHttpClient(BuildConfig.SERVER_BASE_URL), SecureSessionStore(this))
    }
}
