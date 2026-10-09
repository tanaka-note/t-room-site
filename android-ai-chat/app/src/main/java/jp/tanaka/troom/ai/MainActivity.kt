package jp.tanaka.troom.ai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import jp.tanaka.troom.ai.ui.AiChatApp
import jp.tanaka.troom.ai.data.AiUserActivity

class MainActivity : ComponentActivity() {
    override fun onResume() { super.onResume(); AiUserActivity.window.resume() }
    override fun onPause() { AiUserActivity.window.pause(); super.onPause() }
    override fun onUserInteraction() { super.onUserInteraction(); AiUserActivity.window.interact() }

    private val viewModel: MainViewModel by viewModels {
        val app = application as AiChatApplication
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                MainViewModel(app.repository, app.voiceEngine) as T
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AiChatApp(viewModel) }
    }
}
