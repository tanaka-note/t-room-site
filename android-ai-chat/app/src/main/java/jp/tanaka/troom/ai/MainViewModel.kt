package jp.tanaka.troom.ai

import android.app.Activity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.tanaka.troom.ai.auth.PasskeyAuthenticator
import jp.tanaka.troom.ai.data.AiRepository
import jp.tanaka.troom.ai.model.*
import jp.tanaka.troom.ai.voice.VoiceEngine
import jp.tanaka.troom.ai.voice.VoiceState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AiUiState(
    val loading: Boolean = true,
    val signingIn: Boolean = false,
    val session: SessionInfo? = null,
    val conversations: List<Conversation> = emptyList(),
    val activeConversation: Conversation? = null,
    val messages: List<ChatMessage> = emptyList(),
    val pending: PendingMessage? = null,
    val error: String? = null,
)

class MainViewModel(
    private val repository: AiRepository,
    private val voiceEngine: VoiceEngine,
) : ViewModel() {
    private val mutableState = MutableStateFlow(AiUiState(pending = repository.pendingMessage()))
    val state: StateFlow<AiUiState> = mutableState.asStateFlow()
    val voiceState: StateFlow<VoiceState> = voiceEngine.state

    init { restoreSession() }

    fun signIn(activity: Activity, authenticator: PasskeyAuthenticator) = viewModelScope.launch {
        mutableState.value = mutableState.value.copy(signingIn = true, error = null)
        runCatching {
            val options = repository.requestPasskeyOptions()
            repository.completePasskeyLogin(options, authenticator.authenticate(activity, options.requestJson))
        }.onSuccess { session ->
            mutableState.value = mutableState.value.copy(session = session, signingIn = false, loading = false)
            loadConversations()
        }.onFailure { error ->
            mutableState.value = mutableState.value.copy(signingIn = false, loading = false, error = userMessage(error))
        }
    }

    fun selectConversation(conversation: Conversation) = viewModelScope.launch {
        mutableState.value = mutableState.value.copy(loading = true, error = null)
        runCatching { repository.conversation(conversation.id) }
            .onSuccess { (loaded, messages) -> mutableState.value = mutableState.value.copy(loading = false, activeConversation = loaded, messages = messages) }
            .onFailure { mutableState.value = mutableState.value.copy(loading = false, error = userMessage(it)) }
    }

    fun send(content: String, mode: ConversationMode = ConversationMode.CHAT) = viewModelScope.launch {
        val text = content.trim()
        if (text.isEmpty() || mutableState.value.loading) return@launch
        mutableState.value = mutableState.value.copy(loading = true, error = null)
        runCatching {
            val conversation = mutableState.value.activeConversation ?: repository.createConversation(mode)
            mutableState.value = mutableState.value.copy(
                activeConversation = conversation,
                messages = mutableState.value.messages + ChatMessage("local-${System.nanoTime()}", "user", text, sourceMode = mode, pending = true),
            )
            repository.send(conversation.id, text, mode)
        }.onSuccess { response ->
            val messages = mutableState.value.messages.map { if (it.pending) it.copy(pending = false) else it } + response
            mutableState.value = mutableState.value.copy(loading = false, messages = messages, pending = null)
            refreshSessionAndHistory()
        }.onFailure { error ->
            mutableState.value = mutableState.value.copy(loading = false, pending = repository.pendingMessage(), error = userMessage(error))
        }
    }

    fun retryPending() {
        val pending = mutableState.value.pending ?: return
        viewModelScope.launch {
            mutableState.value = mutableState.value.copy(loading = true, error = null)
            runCatching { repository.send(pending.conversationId, pending.content, pending.mode, pending.clientRequestId) }
                .onSuccess { response ->
                    mutableState.value = mutableState.value.copy(loading = false, pending = null, messages = mutableState.value.messages + response)
                    refreshSessionAndHistory()
                }.onFailure { mutableState.value = mutableState.value.copy(loading = false, error = userMessage(it)) }
        }
    }

    fun startVoice() = viewModelScope.launch {
        val conversation = mutableState.value.activeConversation ?: runCatching { repository.createConversation(ConversationMode.VOICE) }.getOrNull()
        if (conversation != null) {
            mutableState.value = mutableState.value.copy(activeConversation = conversation)
            voiceEngine.start(conversation.id)
        }
    }

    fun stopVoice() = viewModelScope.launch { voiceEngine.stop() }

    fun logout() = viewModelScope.launch {
        repository.logout()
        mutableState.value = AiUiState(loading = false)
    }

    fun dismissError() { mutableState.value = mutableState.value.copy(error = null) }

    private fun restoreSession() = viewModelScope.launch {
        runCatching { repository.session() }.onSuccess { session ->
            mutableState.value = mutableState.value.copy(session = session, loading = false)
            loadConversations()
        }.onFailure { mutableState.value = mutableState.value.copy(loading = false) }
    }

    private fun loadConversations() = viewModelScope.launch {
        runCatching { repository.conversations() }.onSuccess { conversations ->
            mutableState.value = mutableState.value.copy(conversations = conversations)
            if (mutableState.value.activeConversation == null && conversations.isNotEmpty()) selectConversation(conversations.first())
        }
    }

    private fun refreshSessionAndHistory() = viewModelScope.launch {
        runCatching { repository.session() }.onSuccess { mutableState.value = mutableState.value.copy(session = it) }
        runCatching { repository.conversations() }.onSuccess { mutableState.value = mutableState.value.copy(conversations = it) }
    }

    private fun userMessage(error: Throwable): String = error.message?.takeIf { it.isNotBlank() }
        ?: "処理を完了できませんでした。通信状態を確認してください。"
}
