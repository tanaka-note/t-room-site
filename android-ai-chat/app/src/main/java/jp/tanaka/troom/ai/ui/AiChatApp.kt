@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package jp.tanaka.troom.ai.ui

import android.app.Activity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import jp.tanaka.troom.ai.AiUiState
import jp.tanaka.troom.ai.MainViewModel
import jp.tanaka.troom.ai.auth.PasskeyAuthenticator
import jp.tanaka.troom.ai.model.*
import jp.tanaka.troom.ai.ui.theme.AiChatTheme
import jp.tanaka.troom.ai.voice.VoiceState
import java.text.NumberFormat
import java.util.Locale

private enum class Destination(val label: String) { CHAT("チャット"), VOICE("会話"), HISTORY("履歴"), ACCOUNT("アカウント") }

@Composable
fun AiChatApp(viewModel: MainViewModel) {
    AiChatTheme {
        val state by viewModel.state.collectAsStateWithLifecycle()
        val voiceState by viewModel.voiceState.collectAsStateWithLifecycle()
        val context = LocalContext.current
        val snackbarHostState = remember { SnackbarHostState() }
        LaunchedEffect(state.error) {
            state.error?.let { snackbarHostState.showSnackbar(it); viewModel.dismissError() }
        }
        if (state.session == null) {
            LoginScreen(state.loading, state.signingIn, onLogin = {
                (context as? Activity)?.let { viewModel.signIn(it, PasskeyAuthenticator()) }
            }, snackbarHostState)
        } else {
            MainShell(state, voiceState, snackbarHostState, viewModel)
        }
    }
}

@Composable
private fun LoginScreen(loading: Boolean, signingIn: Boolean, onLogin: () -> Unit, snackbar: SnackbarHostState) {
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(MaterialTheme.colorScheme.background, MaterialTheme.colorScheme.primaryContainer.copy(alpha = .6f))))) {
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(20.dp))
        Column(
            Modifier.align(Alignment.Center).padding(horizontal = 34.dp).widthIn(max = 460.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.primary, modifier = Modifier.size(82.dp)) {
                Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.padding(22.dp))
            }
            Spacer(Modifier.height(28.dp))
            Text("AI Chat", fontSize = 38.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1).sp)
            Text("By T-ROOM", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(18.dp))
            Text("考えを整理し、会話を育てるための静かな場所。", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(42.dp))
            Button(onClick = onLogin, enabled = !loading && !signingIn, modifier = Modifier.fillMaxWidth().height(56.dp), shape = RoundedCornerShape(18.dp)) {
                if (loading || signingIn) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Icon(Icons.Outlined.Fingerprint, null)
                Spacer(Modifier.width(10.dp))
                Text(if (signingIn) "端末で確認しています" else "パスキーで続ける")
            }
            Spacer(Modifier.height(14.dp))
            Text("ID・パスワードは使用しません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MainShell(state: AiUiState, voiceState: VoiceState, snackbar: SnackbarHostState, viewModel: MainViewModel) {
    var destination by rememberSaveable { mutableStateOf(Destination.CHAT) }
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Column { Text(destination.label, fontWeight = FontWeight.SemiBold); if (destination == Destination.CHAT) Text("ずんだもん", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                actions = {
                    if (destination == Destination.CHAT) IconButton(onClick = { destination = Destination.HISTORY }) { Icon(Icons.Outlined.AddComment, "会話履歴") }
                },
            )
        },
        bottomBar = {
            NavigationBar(tonalElevation = 0.dp) {
                Destination.entries.forEach { item ->
                    val icon = when (item) {
                        Destination.CHAT -> Icons.Outlined.ChatBubbleOutline
                        Destination.VOICE -> Icons.Outlined.GraphicEq
                        Destination.HISTORY -> Icons.Outlined.History
                        Destination.ACCOUNT -> Icons.Outlined.PersonOutline
                    }
                    NavigationBarItem(selected = destination == item, onClick = { destination = item }, icon = { Icon(icon, null) }, label = { Text(item.label) })
                }
            }
        },
    ) { padding ->
        AnimatedContent(destination, label = "main-navigation", modifier = Modifier.padding(padding)) { target ->
            when (target) {
                Destination.CHAT -> ChatScreen(state, viewModel::send, viewModel::retryPending)
                Destination.VOICE -> VoiceScreen(voiceState, viewModel::startVoice, viewModel::stopVoice)
                Destination.HISTORY -> HistoryScreen(state.conversations) { viewModel.selectConversation(it); destination = Destination.CHAT }
                Destination.ACCOUNT -> AccountScreen(state.session!!, viewModel::logout)
            }
        }
    }
}

@Composable
private fun ChatScreen(state: AiUiState, onSend: (String, ConversationMode) -> Unit, onRetry: () -> Unit) {
    var input by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size) { if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex) }
    Column(Modifier.fillMaxSize()) {
        if (state.pending != null) {
            Surface(color = MaterialTheme.colorScheme.errorContainer) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("未同期のメッセージがあります", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onRetry) { Text("再送") }
                }
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            if (state.messages.isEmpty()) item {
                Column(Modifier.fillParentMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(38.dp))
                    Spacer(Modifier.height(14.dp)); Text("今日は何について話しますか？", style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(7.dp)); Text("相談、整理、アイデアづくりをお手伝いします。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(state.messages, key = { it.id }) { MessageBubble(it) }
        }
        Surface(tonalElevation = 2.dp) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 10.dp, top = 10.dp, bottom = 12.dp), verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("メッセージ") },
                    modifier = Modifier.weight(1f),
                    maxLines = 6,
                    shape = RoundedCornerShape(24.dp),
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(onClick = { val value = input; input = ""; onSend(value, ConversationMode.CHAT) }, enabled = input.isNotBlank() && !state.loading, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Rounded.ArrowUpward, "送信")
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val user = message.role == "user"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Surface(
            color = if (user) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
            shape = RoundedCornerShape(if (user) 22.dp else 0.dp),
            modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth(if (user) .86f else 1f),
        ) {
            Column(Modifier.padding(if (user) 16.dp else 2.dp)) {
                if (!user) Text("ずんだもん", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                if (!user) Spacer(Modifier.height(6.dp))
                Text(message.content, style = MaterialTheme.typography.bodyLarge, lineHeight = 25.sp)
                if (message.pending) Text("送信中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun VoiceScreen(state: VoiceState, onStart: () -> Unit, onStop: () -> Unit) {
    val active = state is VoiceState.Listening || state is VoiceState.Speaking || state is VoiceState.Connecting
    val scale by animateFloatAsState(if (active) 1f else .82f, label = "voice-orb")
    Column(Modifier.fillMaxSize().padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size((190 * scale).dp).clip(CircleShape).background(Brush.radialGradient(listOf(MaterialTheme.colorScheme.primary.copy(.92f), MaterialTheme.colorScheme.secondary.copy(.52f)))), contentAlignment = Alignment.Center) {
            Icon(if (active) Icons.Outlined.GraphicEq else Icons.Outlined.Mic, null, tint = Color.White, modifier = Modifier.size(58.dp))
        }
        Spacer(Modifier.height(38.dp))
        Text(when (state) { VoiceState.Listening -> "聞いています"; VoiceState.Speaking -> "話しています"; VoiceState.Connecting -> "接続しています"; else -> "会話モード" }, style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(10.dp))
        Text(when (state) { is VoiceState.Unavailable -> state.reason; is VoiceState.Failed -> state.message; else -> "チャットと同じ会話の続きを、ハンズフリーで話せます。" }, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(30.dp))
        FilledTonalButton(onClick = if (active) onStop else onStart) { Icon(if (active) Icons.Outlined.StopCircle else Icons.Outlined.Mic, null); Spacer(Modifier.width(8.dp)); Text(if (active) "会話を終了" else "会話を開始") }
    }
}

@Composable
private fun HistoryScreen(conversations: List<Conversation>, onSelect: (Conversation) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(18.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (conversations.isEmpty()) item { Text("会話履歴はまだありません。", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(14.dp)) }
        items(conversations, key = { it.id }) { conversation ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable { onSelect(conversation) }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.ChatBubbleOutline, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                    Text(if (conversation.currentMode == ConversationMode.VOICE) "音声会話" else "チャット", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun AccountScreen(session: SessionInfo, onLogout: () -> Unit) {
    val yen = NumberFormat.getCurrencyInstance(Locale.JAPAN)
    val progress = session.budget.usageRatio.toFloat().coerceIn(0f, 1f)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(22.dp), verticalArrangement = Arrangement.spacedBy(26.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer, modifier = Modifier.size(58.dp)) { Icon(Icons.Outlined.Person, null, modifier = Modifier.padding(15.dp)) }
                Spacer(Modifier.width(16.dp)); Column { Text(session.user.displayName, style = MaterialTheme.typography.titleLarge); Text("Passkey認証済み", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("今月の利用額", style = MaterialTheme.typography.titleMedium); Text(yen.format(session.usage.totalCostJpy), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold) }
                LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth().height(8.dp).clip(CircleShape))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("安全枠の残り"); Text(yen.format(session.budget.remainingJpy)) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("月末予測"); Text(yen.format(session.budget.projectedMonthEndJpy)) }
                Text("月額上限 ${yen.format(session.budget.monthlyBudgetJpy)} ・ 現在の安全停止 ${yen.format(session.budget.activeLimitJpy)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (session.budget.stopped) AssistChip(onClick = {}, label = { Text("新しいAI処理は安全停止中です") }, leadingIcon = { Icon(Icons.Outlined.GppGood, null) })
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("トークン", style = MaterialTheme.typography.titleMedium)
                MetricRow("input", session.usage.inputTokens); MetricRow("output", session.usage.outputTokens); MetricRow("cached", session.usage.cachedInputTokens)
                MetricRow("audio input", session.usage.audioInputTokens); MetricRow("audio output", session.usage.audioOutputTokens)
            }
        }
        if (session.usage.byModel.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                Text("モデル別利用料金", style = MaterialTheme.typography.titleMedium)
                session.usage.byModel.forEach { MetricRow(it.model, yen.format(it.costJpy), "${it.requests}回") }
            }
        }
        item {
            Text("予算変更、安全停止の解除、予備枠の解放はSecurity Centerだけで行えます。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(16.dp)); OutlinedButton(onClick = onLogout) { Icon(Icons.AutoMirrored.Outlined.Logout, null); Spacer(Modifier.width(8.dp)); Text("ログアウト") }
        }
    }
}

@Composable private fun MetricRow(label: String, value: Long) = MetricRow(label, NumberFormat.getIntegerInstance(Locale.JAPAN).format(value), null)
@Composable private fun MetricRow(label: String, value: String, note: String?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant); Row { note?.let { Text("$it  ", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }; Text(value, fontWeight = FontWeight.Medium) } }
}
