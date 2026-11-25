@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package jp.tanaka.troom.calendar

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.collectLatest
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

enum class CalendarPage(val label: String) { MONTH("月間カレンダー"), WEEK("週間カレンダー"), AGENDA("予定一覧"), TRACKS("追跡"), SETTINGS("設定") }
val eventColors = linkedMapOf("blue" to Color(0xFF2775A4), "green" to Color(0xFF26795C), "pink" to Color(0xFFAC4F75), "orange" to Color(0xFFA96820), "purple" to Color(0xFF7754AA), "gray" to Color(0xFF69727A))
val colorNames = listOf("ブルー", "グリーン", "ピンク", "オレンジ", "ラベンダー", "グレー")
private val dateFormat = DateTimeFormatter.ofPattern("M月d日(E)", Locale.JAPAN)
private val calendarDateFormat = DateTimeFormatter.ofPattern("yyyy年M月d日(E)", Locale.JAPAN)
private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")

@Composable fun CalendarApp(model: MainViewModel, activity: MainActivity) {
    val state by model.state.collectAsStateWithLifecycle()
    val dark = when (state.settings.appearance) { "light" -> false; "dark" -> true; else -> isSystemInDarkTheme() }
    val colors = remember(state.settings.theme, dark) { calendarColorScheme(state.settings.theme, dark) }
    LaunchedEffect(dark) {
        val bars = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT) { dark }
        activity.enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
    }
    MaterialTheme(colorScheme = colors) {
        Surface(Modifier.fillMaxSize()) {
            if (activity.calendarOpened) {
                if (state.account == null) LoginScreen(state, model, activity) else CalendarShell(state, model, activity)
            }
        }
        activity.missingReminderPermission?.let { ReminderPermissionDialog(it, activity) }
    }
}

@Composable
private fun ReminderPermissionDialog(permission: ReminderPermission, activity: MainActivity) {
    var settingsUnavailable by remember(permission) { mutableStateOf(false) }
    val requestNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        activity.onNotificationPermissionResult()
    }
    val closeApp: () -> Unit = { activity.moveTaskToBack(true) }
    val (message, action) = when (permission) {
        ReminderPermission.NOTIFICATIONS ->
            "予定の通知を受け取るため、カレンダーの通知を許可してください。" to "通知を許可"
        ReminderPermission.EXACT_ALARMS ->
            "指定した時刻に通知するため、Androidの「アラームとリマインダー」でカレンダーを許可してください。" to "時刻の予約を許可"
    }
    AlertDialog(
        onDismissRequest = closeApp,
        title = { Text("通知の設定が必要です") },
        text = {
            Text(if (settingsUnavailable) "$message 端末の設定から許可してください。" else message)
        },
        confirmButton = {
            Button(onClick = {
                settingsUnavailable = !activity.requestReminderPermission(permission) { requestNotifications.launch(it) }
            }) { Text(action) }
        },
        dismissButton = { TextButton(onClick = closeApp) { Text("アプリを閉じる") } },
        properties = DialogProperties(dismissOnClickOutside = false),
    )
}

@Composable private fun LoginScreen(state: CalendarState, model: MainViewModel, activity: MainActivity) {
    Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.CalendarMonth, null, Modifier.size(60.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(20.dp)); Text("カレンダー", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(12.dp)); Text("予定と、最後からの日数をまとめて管理", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(28.dp))
        if (state.links.isNotEmpty()) {
            TextButton(onClick = { model.login(activity) }, enabled = !state.busy) { Text("別のパスキーで認証") }
            Text("利用するアカウントを選択", style = MaterialTheme.typography.titleMedium)
            state.links.forEach { link -> OutlinedButton(onClick = { model.select(link) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text(link.name) } }
            TextButton(onClick = { model.cancelLogin() }, enabled = !state.busy) { Text("利用方法の選択へ戻る") }
        } else {
            Button(onClick = { model.login(activity) }, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("パスキーでログイン") }
            Text("許可されたDBと同期して利用します", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
            OutlinedButton(onClick = { model.useLocal() }, enabled = !state.busy, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text("ログインせずこの端末で使う") }
            Text("端末内に保存・端末間の同期なし", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
        }
        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 16.dp))
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 16.dp)) }
    }
}

@Composable private fun CalendarShell(state: CalendarState, model: MainViewModel, activity: MainActivity) {
    val drawer = rememberDrawerState(DrawerValue.Closed); val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(CalendarPage.MONTH) }; var initialPageApplied by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(today()) }
    var month by remember { mutableStateOf(YearMonth.from(selected)) }
    val headingMonth = if (page == CalendarPage.WEEK) YearMonth.from(selected) else month
    fun selectDay(day: LocalDate) {
        selected = day
        month = YearMonth.from(day)
    }
    var query by remember { mutableStateOf("") }; var searching by remember { mutableStateOf(false) }
    var trackFilter by remember { mutableStateOf<String?>(null) }; var trackDetail by remember { mutableStateOf<NamedItem?>(null) }
    var editing by remember { mutableStateOf<CalendarEvent?>(null) }; var editingOccurrence by remember { mutableStateOf<Occurrence?>(null) }
    var editMode by remember { mutableStateOf("ALL") }; var editorOpen by remember { mutableStateOf(false) }
    var prefillTrack by remember { mutableStateOf<String?>(null) }; var detail by remember { mutableStateOf<Occurrence?>(null) }
    var logoutDialog by remember { mutableStateOf(false) }; var seriesChoice by remember { mutableStateOf<Occurrence?>(null) }
    var reviewConflict by remember { mutableStateOf(true) }
    var settingsView by remember { mutableStateOf("settings") }
    fun backFromSettings() { if (settingsView != "settings") settingsView = "settings" else { initialPageApplied = true; page = CalendarPage.MONTH } }
    fun addEvent() { editing = null; editingOccurrence = null; prefillTrack = trackDetail?.id; editMode = "ALL"; editorOpen = true }
    val savedScreens = rememberSaveableStateHolder()
    val events = model.events()
    val visible = events.filter { it.deletedAt == null }
    val matches: (Occurrence) -> Boolean = { occurrence -> val e = occurrence.event; (trackFilter == null || trackFilter in e.trackIds) && (query.isBlank() || (e.title + e.memo + e.place + e.url + state.tracks.filter { it.id in e.trackIds }.joinToString { it.name } + state.tags.filter { it.id in e.tagIds }.joinToString { it.name }).contains(query, true)) }
    LaunchedEffect(state.conflict?.pending?.requestId) { reviewConflict = true }
    LaunchedEffect(state.account?.id, state.lastSync) { if (!initialPageApplied && (state.lastSync > 0 || state.entities.any { it.kind == "settings" })) { page = runCatching { CalendarPage.valueOf(state.settings.startPage) }.getOrDefault(CalendarPage.MONTH); initialPageApplied = true } }
    LaunchedEffect(Unit) { while (true) { delay(30000); if (CalendarActivityWindow.foreground) model.sync(false) } }
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    BackHandler(trackDetail != null && !drawer.isOpen) { trackDetail = null }
    BackHandler(page == CalendarPage.SETTINGS && !drawer.isOpen && !logoutDialog) { backFromSettings() }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = !editorOpen && (page != CalendarPage.MONTH || drawer.isOpen), drawerContent = {
        ModalDrawerSheet(Modifier.width(292.dp)) {
            Spacer(Modifier.height(12.dp)); Text(state.account?.name.orEmpty(), Modifier.padding(horizontal = 20.dp, vertical = 12.dp), style = MaterialTheme.typography.titleMedium)
            CalendarPage.entries.forEach { item -> NavigationDrawerItem(label = { Text(item.label) }, selected = page == item, onClick = { initialPageApplied = true; page = item; settingsView = "settings"; trackFilter = null; trackDetail = null; query = ""; scope.launch { drawer.close() } }, modifier = Modifier.padding(horizontal = 8.dp, vertical = 1.dp)) }
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            TextButton(onClick = { scope.launch { drawer.close() }; logoutDialog = true }, modifier = Modifier.padding(horizontal = 12.dp)) { Text(if (state.account?.localOnly == true) "利用方法を選び直す" else "アカウントを選び直す") }
            if (state.account?.localOnly != true) TextButton(onClick = { model.sync(); scope.launch { drawer.close() } }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("今すぐ同期") }
        }
    }) {
        Scaffold(contentWindowInsets = WindowInsets.safeDrawing, floatingActionButton = {
            if (page != CalendarPage.SETTINGS) FloatingActionButton(onClick = { addEvent() }, containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) { Icon(Icons.Default.Add, "予定を追加") }
        }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                Row(Modifier.fillMaxWidth().height(48.dp).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = .55f)), verticalAlignment = Alignment.CenterVertically) {
                    if (page == CalendarPage.SETTINGS) IconButton(onClick = { backFromSettings() }, modifier = Modifier.size(44.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, if (settingsView == "settings") "カレンダーへ戻る" else "設定へ戻る") }
                    else IconButton(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.size(44.dp)) { Icon(Icons.Default.Menu, "メニュー") }
                    Text(if (page in listOf(CalendarPage.MONTH, CalendarPage.WEEK, CalendarPage.AGENDA)) "${headingMonth.year}年${headingMonth.monthValue}月" else page.label, Modifier.weight(1f), maxLines = 1, style = MaterialTheme.typography.titleMedium)
                    if (page == CalendarPage.SETTINGS) IconButton(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.size(44.dp)) { Icon(Icons.Default.Menu, "メニュー") }
                    if (page in listOf(CalendarPage.MONTH, CalendarPage.WEEK, CalendarPage.AGENDA)) {
                        IconButton(onClick = { if (page == CalendarPage.WEEK) selectDay(selected.minusWeeks(1)) else month = month.minusMonths(1) }, enabled = headingMonth > YearMonth.of(1, 1), modifier = Modifier.size(40.dp)) { Icon(Icons.Default.ChevronLeft, "前へ") }
                        IconButton(onClick = { if (page == CalendarPage.WEEK) selectDay(selected.plusWeeks(1)) else month = month.plusMonths(1) }, enabled = headingMonth < YearMonth.of(9999, 12), modifier = Modifier.size(40.dp)) { Icon(Icons.Default.ChevronRight, "次へ") }
                        IconButton(onClick = { selectDay(today()) }, modifier = Modifier.size(40.dp)) { Icon(Icons.Default.Today, "今日") }
                        IconButton(onClick = { searching = !searching; if (!searching) query = "" }, modifier = Modifier.size(40.dp)) { Icon(Icons.Default.Search, "検索") }
                    }
                }
                if (searching && page in listOf(CalendarPage.MONTH, CalendarPage.WEEK, CalendarPage.AGENDA)) OutlinedTextField(query, { query = it }, label = { Text("表示中の予定・追跡・タグを検索") }, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp), singleLine = true)
                if (state.offline || state.pending.isNotEmpty()) Text(if (state.offline) "オフライン・取得済みの予定を表示${if (state.pending.isNotEmpty()) "／未同期 ${state.pending.size}件" else ""}" else "未同期 ${state.pending.size}件", modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                if (trackFilter != null) Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) { Text("追跡：${state.tracks.find { it.id == trackFilter }?.name.orEmpty()}", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium); TextButton(onClick = { trackFilter = null }) { Text("全予定へ") } }
                if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
                state.error?.takeUnless { state.offline && it.startsWith("オフライン") }?.let { Text(it, Modifier.fillMaxWidth().padding(8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                state.reminderIssue?.let {
                    Text(it.message, Modifier.fillMaxWidth().padding(8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (state.conflict != null && !reviewConflict) TextButton(onClick = { reviewConflict = true }) { Text("同期の競合を確認") }
                Box(Modifier.weight(1f)) {
                    savedScreens.SaveableStateProvider(if (page == CalendarPage.TRACKS && trackDetail != null) "TRACK-${trackDetail!!.id}" else page.name) {
                    when (page) {
                        CalendarPage.MONTH -> MonthScreen(month, selected, visible, model.holidays, onDay = { selectDay(it) }, onEvent = { detail = it }, onMonth = { month = it }, matches = matches)
                        CalendarPage.WEEK -> WeekScreen(selected, visible, model.holidays, onEvent = { detail = it }, matches = matches)
                        CalendarPage.AGENDA -> AgendaScreen(month, visible, model.holidays, onEvent = { detail = it }, matches = matches)
                        CalendarPage.TRACKS -> if (trackDetail == null) TrackingScreen(state, events, onSelect = { trackDetail = it }, onSettings = { model.settings(it) }, onNew = { name -> model.named("track", NamedItem(name = name)) }) else TrackingDetail(trackDetail!!, state, events, onBack = { trackDetail = null }, onAdd = { editing = null; editingOccurrence = null; prefillTrack = trackDetail?.id; editMode = "ALL"; editorOpen = true }, onCalendar = { trackFilter = trackDetail?.id; page = CalendarPage.MONTH; trackDetail = null }, onEvent = { detail = it }, onEdit = { model.named("track", it); trackDetail = it }, onMerge = { source, target -> scope.launch { model.merge("track", source, target); trackDetail = null; } })
                        CalendarPage.SETTINGS -> SettingsScreen(state, model, activity, settingsView, onLogout = { logoutDialog = true }) { settingsView = it }
                    }
                    }
                }
            }
        }
    }
    if (detail != null) EventDetail(detail!!, state, onDismiss = { detail = null }, onEdit = { occurrence -> detail = null; if (occurrence.series.repeat.mode != "NONE") seriesChoice = occurrence else { editing = occurrence.event; editingOccurrence = null; prefillTrack = null; editorOpen = true } }, onChange = { occurrence, action -> scope.launch { val e = occurrence.series; val changed = when (action) { "cancel" -> if (e.repeat.mode == "NONE") e.copy(cancelled = !e.cancelled) else e.copy(exceptions = e.exceptions + (occurrence.anchor to org.json.JSONObject(e.exceptions[occurrence.anchor]?.toString() ?: "{}").put("cancelled", !occurrence.cancelled))); else -> if (e.repeat.mode == "NONE") e.copy(deletedAt = System.currentTimeMillis()) else e.copy(exceptions = e.exceptions + (occurrence.anchor to org.json.JSONObject(e.exceptions[occurrence.anchor]?.toString() ?: "{}").put("deleted", true).put("deletedAt", System.currentTimeMillis()))) }; model.saveEvent(changed); detail = null } })
    seriesChoice?.let { occurrence -> AlertDialog(onDismissRequest = { seriesChoice = null }, title = { Text("繰り返し予定を編集") }, text = { Column { listOf("ONE" to "この回だけ", "FUTURE" to "この回以降", "ALL" to "すべての予定").forEach { (mode, text) -> TextButton(onClick = { editMode = mode; editingOccurrence = occurrence; editing = if (mode == "ALL") occurrence.series else occurrence.event.copy(start = occurrence.start, end = occurrence.end); prefillTrack = null; editorOpen = true; seriesChoice = null }) { Text(text) } } } }, confirmButton = {}) }
    if (editorOpen) EventEditor(state, editing, selected, prefillTrack, onDismiss = { editorOpen = false }, reminderKey = editingOccurrence?.takeIf { editMode == "ONE" }?.let { "${it.series.id}@${it.anchor}" }, onDelete = { val target = editingOccurrence?.series ?: editing; if (target == null) false else model.saveEvent(target.copy(deletedAt = System.currentTimeMillis())) }, onSave = { result, names, tagNames, minutes ->
        val trackIds = model.findOrCreate("track", names); val tagIds = model.findOrCreate("tag", tagNames)
        var value = result.copy(trackIds = trackIds, tagIds = tagIds)
        val occurrence = editingOccurrence
        val changes = mutableListOf<Pair<String, org.json.JSONObject>>()
        if (occurrence != null && editMode == "ONE") {
            value = value.copy(id = occurrence.series.id, repeat = RepeatRule(), exceptions = emptyMap())
            changes += "event" to occurrence.series.copy(exceptions = occurrence.series.exceptions + (occurrence.anchor to org.json.JSONObject().put("replacement", value.json()))).json()
        } else if (occurrence != null && editMode == "FUTURE") {
            val before = LocalDate.parse(occurrence.anchor).minusDays(1)
            if (before < occurrence.series.start.toLocalDate()) { value = value.copy(id = occurrence.series.id); changes += "event" to value.json() }
            else {
                val old = occurrence.series.copy(repeat = occurrence.series.repeat.copy(until = minOf(before, occurrence.series.repeat.until ?: before)))
                val priorCount = occurrence.series.copy(excludedDates = emptySet(), exceptions = emptyMap()).occurrences(occurrence.series.start.toLocalDate(), before).size
                val remaining = value.repeat.count?.let { if (it == occurrence.series.repeat.count) maxOf(1, it - priorCount) else it }
                val nextId = newId()
                value = value.copy(id = nextId, repeat = value.repeat.copy(count = remaining, dates = value.repeat.dates.filter { it > before }), excludedDates = value.excludedDates.filter { it > before }.toSet(), exceptions = value.exceptions.filterKeys { LocalDate.parse(it) > before }.mapValues { (_, v) -> org.json.JSONObject(v.toString()).apply { optJSONObject("replacement")?.put("id", nextId) } })
                changes += "event" to old.json(); changes += "event" to value.json()
            }
        } else changes += "event" to value.json()
        val reminderKey = occurrence?.takeIf { editMode == "ONE" }?.let { "${it.series.id}@${it.anchor}" } ?: value.id
        val reminderMap = if (minutes != null) state.settings.eventReminders + (reminderKey to minutes) else state.settings.eventReminders - reminderKey
        if (reminderMap != state.settings.eventReminders) changes += "settings" to state.settings.copy(eventReminders = reminderMap).json()
        val original = occurrence?.series ?: editing
        val versions = changes.filter { it.first == "event" }.associate { (_, body) -> "event:${body.getString("id")}" to (if (body.getString("id") == original?.id) original?.revision ?: 0 else 0) }
        val saved = model.repository.saveBatch(changes, versions)
        if (saved) {
            model.sync()
            editorOpen = false; selectDay(value.start.toLocalDate())
        }
        saved
    })
    if (logoutDialog) AlertDialog(onDismissRequest = { logoutDialog = false }, title = { Text(if (state.account?.localOnly == true) "利用方法を選び直す" else "ログアウトしますか？") }, text = { Text(if (state.account?.localOnly == true) "端末内の予定は残したまま、ログイン画面へ戻ります。この端末の予定の通知は、利用を再開するまで停止します。" else if (state.pending.isEmpty()) "「${state.account?.name.orEmpty()}」からログアウトし、ログイン画面へ戻ります。この端末の通知と同期は停止します。保存済みの予定はサーバーに残ります。" else "未同期の変更があります。同期してからログアウトするか、未同期の変更を破棄してください。") }, confirmButton = { TextButton(onClick = { model.logout(); logoutDialog = false }) { Text(if (state.account?.localOnly == true) "ログイン画面へ" else if (state.pending.isEmpty()) "ログアウト" else "同期してからログアウト") } }, dismissButton = { Row { if (state.pending.isNotEmpty()) TextButton(onClick = { model.logout(true); logoutDialog = false }) { Text("未同期を破棄") }; TextButton(onClick = { logoutDialog = false }) { Text("戻る") } } })
    state.conflict?.takeIf { reviewConflict }?.let { conflict ->
        val affected = conflictClosure(state.pending, conflict.pending).flatMap { it.operations() }.distinctBy { it.key }
        AlertDialog(onDismissRequest = { reviewConflict = false }, title = { Text("別の端末で変更されています") }, text = { Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState())) {
            Text("関連する未同期の変更 ${affected.size}件を確認してください。サーバーを選ぶと、下記に関する端末側の未同期変更を破棄します。")
            affected.forEach { operation -> Text("この端末", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp)); val local = state.entities.firstOrNull { it.key == operation.key }; Text(conflictPreview(operation.kind, local?.body ?: operation.payload)) }
            Text("競合した変更のサーバー情報", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp)); if (conflict.servers.isEmpty()) Text("該当する項目がありません") else conflict.servers.forEach { Text(conflictPreview(it.kind, it.body)) }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } }, confirmButton = { TextButton(enabled = conflict.servers.none { it.purged }, onClick = { model.resolve(true) }) { Text("この端末を保存") } }, dismissButton = { Row { TextButton(onClick = { reviewConflict = false }) { Text("あとで") }; TextButton(onClick = { model.resolve(false) }) { Text("サーバーを採用") } } })
    }
}

private fun conflictPreview(kind: String, v: org.json.JSONObject): String = when {
    v.optBoolean("purged") -> "完全削除済み"
    kind == "event" -> runCatching { CalendarEvent.parse(v).let { e -> listOf(e.title, "${e.start} ～ ${e.end}", if (e.cancelled) "中止" else if (e.deletedAt != null) "ゴミ箱" else "予定", e.repeat.label(), e.place, e.memo, e.url).filter { it.isNotBlank() }.joinToString("\n") } }.getOrDefault("予定を確認できません")
    kind == "settings" -> CalendarSettings.parse(v).let { "表示：${runCatching { CalendarPage.valueOf(it.startPage).label }.getOrDefault("月間")}\n予定の長さ：${it.durationMinutes}分\n通知：${it.reminders.joinToString { n -> "${n}分前" }.ifEmpty { "なし" }}\n個別通知：${it.eventReminders.size}件\n並び順：${when (it.sort) { "NAME" -> "名前"; "ELAPSED" -> "経過日数"; else -> "手動" }}" }
    else -> "${v.optString("name")}\n${if (v.optBoolean("archived")) "アーカイブ" else "使用中"}\n目安：${v.optionalLong("targetDays")?.let { "${it}日" } ?: "なし"}"
}

@Composable private fun MonthScreen(month: YearMonth, selected: LocalDate, events: List<CalendarEvent>, holidays: Map<LocalDate, String>, onDay: (LocalDate) -> Unit, onEvent: (Occurrence) -> Unit, onMonth: (YearMonth) -> Unit, matches: (Occurrence) -> Boolean) {
    val pager = rememberPagerState(initialPage = calendarMonthPage(month), pageCount = { CALENDAR_MONTH_COUNT })
    val currentOnMonth by rememberUpdatedState(onMonth)
    var pendingPage by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(month) {
        val target = calendarMonthPage(month)
        pendingPage = target
        try {
            if (pager.currentPage != target || pager.currentPageOffsetFraction != 0f) pager.animateScrollToPage(target, animationSpec = tween(250))
        } finally {
            // A newer button request cancels this effect. Retain the pending
            // state so an intermediate settled page cannot overwrite that request.
            if (currentCoroutineContext().isActive) pendingPage = null
        }
    }
    LaunchedEffect(pager) {
        snapshotFlow { Triple(pager.settledPage, pager.isScrollInProgress, pendingPage) }.collectLatest { (_, scrolling, pending) ->
            if (!scrolling && pending == null) {
                withFrameNanos { }
                if (!pager.isScrollInProgress && pendingPage == null) currentOnMonth(calendarMonthAt(pager.settledPage))
            }
        }
    }
    val dayList = remember(events, selected, matches) { events.flatMap { it.occurrences(selected, selected) }.filterNot { it.deleted }.filter(matches).sortedWith(compareByDescending<Occurrence> { it.event.allDay }.thenBy { it.start }) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().height(24.dp)) { listOf("日", "月", "火", "水", "木", "金", "土").forEachIndexed { i, text -> Text(text, Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = if (i == 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp) } }
        HorizontalPager(state = pager, modifier = Modifier.fillMaxWidth().weight(1f), key = { it }) { index ->
            MonthGrid(calendarMonthAt(index), selected, events, holidays, onDay, onEvent, matches)
        }
        Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 74.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    selected.format(dateFormat),
                    Modifier.semantics { contentDescription = "選択中の日付：${selected.format(calendarDateFormat)}" },
                    style = MaterialTheme.typography.labelLarge,
                )
                Text("選択中・${dayList.size}件", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
        }
        if (dayList.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 124.dp), contentPadding = PaddingValues(end = 74.dp, bottom = 4.dp)) { items(dayList, key = { it.key }) { EventRow(it, onEvent) } }
    }
}

@Composable private fun MonthGrid(month: YearMonth, selectedDay: LocalDate, events: List<CalendarEvent>, holidays: Map<LocalDate, String>, onDay: (LocalDate) -> Unit, onEvent: (Occurrence) -> Unit, matches: (Occurrence) -> Boolean) {
    val first = month.atDay(1).let { it.minusDays((it.dayOfWeek.value % 7).toLong()) }
    val rows = ((month.atDay(1).dayOfWeek.value % 7 + month.lengthOfMonth() + 6) / 7)
    val instances = remember(events, month, matches) { events.flatMap { it.occurrences(first, first.plusDays(rows * 7L - 1)) }.filterNot { it.deleted }.filter(matches) }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val lines = ((maxHeight.value / rows - 29) / 18).toInt().coerceIn(1, 6)
            Column(Modifier.fillMaxSize()) {
                repeat(rows) { row -> Row(Modifier.fillMaxWidth().weight(1f)) {
                    repeat(7) { col ->
                        val day = first.plusDays((row * 7 + col).toLong())
                        val list = instances.filter { it.start.toLocalDate() <= day && it.end > day.atStartOfDay() }.sortedWith(compareByDescending<Occurrence> { it.event.allDay }.thenBy { it.start })
                        val chosen = day == selectedDay
                        Column(Modifier.weight(1f).fillMaxHeight().border(if (chosen) 1.5.dp else .3.dp, if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant).background(if (chosen) MaterialTheme.colorScheme.primaryContainer.copy(alpha = .65f) else Color.Transparent).clickable { onDay(day) }.semantics { selected = chosen; contentDescription = day.format(calendarDateFormat) + (if (chosen) " 選択中" else "") + (if (day == today()) " 今日" else "") }.padding(horizontal = 2.dp, vertical = 3.dp)) {
                            Box(Modifier.align(Alignment.CenterHorizontally).size(24.dp).clip(RoundedCornerShape(12.dp)).background(if (chosen) MaterialTheme.colorScheme.primary else Color.Transparent).then(if (day == today() && !chosen) Modifier.border(1.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(12.dp)) else Modifier), contentAlignment = Alignment.Center) { Text(day.dayOfMonth.toString(), fontSize = 12.sp, color = if (chosen) MaterialTheme.colorScheme.onPrimary else if (day.month != month.month) MaterialTheme.colorScheme.onSurface.copy(alpha = .4f) else if (col == 0 || holidays.containsKey(day)) MaterialTheme.colorScheme.error else if (day == today()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface) }
                            holidays[day]?.let { Text(it, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.error) }
                            val available = maxOf(1, lines - if (holidays.containsKey(day)) 1 else 0)
                            list.take(available).forEach { occurrence -> val color = eventColors[occurrence.event.color] ?: eventColors.getValue("blue"); Row(Modifier.fillMaxWidth().padding(top = 1.dp).clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = .16f)).clickable { onEvent(occurrence) }) { Box(Modifier.width(3.dp).height(17.dp).background(color)); Text(occurrence.event.title, Modifier.padding(horizontal = 2.dp, vertical = 1.dp), fontSize = 11.sp, lineHeight = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (occurrence.cancelled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, textDecoration = if (occurrence.cancelled) TextDecoration.LineThrough else null) } }
                            if (list.size > available) Text("＋${list.size - available}件", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } }
            }
        }
}

@Composable fun EventRow(item: Occurrence, onClick: (Occurrence) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onClick(item) }.padding(horizontal = 10.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(3.dp).height(29.dp).background(eventColors[item.event.color] ?: eventColors.getValue("blue"), RoundedCornerShape(2.dp)))
        Text(if (item.event.allDay) "終日" else item.start.format(timeFormat), Modifier.width(52.dp).padding(start = 8.dp), style = MaterialTheme.typography.bodySmall)
        Column(Modifier.weight(1f)) { Text(item.event.title, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, textDecoration = if (item.cancelled) TextDecoration.LineThrough else null); if (item.event.place.isNotBlank()) Text(item.event.place, maxLines = 1, style = MaterialTheme.typography.labelSmall) }
    }
}

@Composable private fun AgendaScreen(month: YearMonth, events: List<CalendarEvent>, holidays: Map<LocalDate, String>, onEvent: (Occurrence) -> Unit, matches: (Occurrence) -> Boolean) {
    val list = remember(events, month, matches) { events.flatMap { it.occurrences(month.atDay(1), month.atEndOfMonth()) }.filterNot { it.deleted }.filter(matches).sortedBy { it.start } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
        if (list.isEmpty()) item { Text("この月の予定はありません", Modifier.padding(20.dp)) }
        list.groupBy { it.start.toLocalDate() }.forEach { (day, entries) -> item("day-$day") { Text(day.format(dateFormat) + (holidays[day]?.let { "  $it" } ?: ""), Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = .4f)).padding(10.dp), style = MaterialTheme.typography.titleSmall) }; items(entries, key = { it.key }) { EventRow(it, onEvent) } }
    }
}

@Composable private fun WeekScreen(selected: LocalDate, events: List<CalendarEvent>, holidays: Map<LocalDate, String>, onEvent: (Occurrence) -> Unit, matches: (Occurrence) -> Boolean) {
    val start = selected.minusDays((selected.dayOfWeek.value % 7).toLong())
    val list = remember(events, start, matches) { events.flatMap { it.occurrences(start, start.plusDays(6)) }.filterNot { it.deleted }.filter(matches) }
    val scroll = rememberScrollState()
    val morning = with(LocalDensity.current) { (8 * 48).dp.roundToPx() }
    LaunchedEffect(start) { if (scroll.value == 0) scroll.scrollTo(morning) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 32.dp)) { repeat(7) { n -> val d = start.plusDays(n.toLong()); Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) { Text(d.format(DateTimeFormatter.ofPattern("E", Locale.JAPAN)), fontSize = 11.sp); Text(d.dayOfMonth.toString(), fontSize = 16.sp, color = if (d == today()) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface); holidays[d]?.let { Text(it, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) } } } }
        Row(Modifier.fillMaxWidth().padding(start = 32.dp)) { repeat(7) { n -> val d = start.plusDays(n.toLong()); Column(Modifier.weight(1f)) { list.filter { it.event.allDay && it.start.toLocalDate() <= d && it.end > d.atStartOfDay() }.take(2).forEach { occurrence -> Text(occurrence.event.title, Modifier.clickable { onEvent(occurrence) }.background(MaterialTheme.colorScheme.primaryContainer).padding(1.dp), fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) } } } }
        Row(Modifier.fillMaxWidth().weight(1f).verticalScroll(scroll)) {
            Column(Modifier.width(32.dp)) { repeat(24) { Text("$it", Modifier.height(48.dp).fillMaxWidth(), fontSize = 10.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center) } }
            repeat(7) { n -> val day = start.plusDays(n.toLong()); val timed = list.filter { !it.event.allDay && it.start < day.plusDays(1).atStartOfDay() && it.end > day.atStartOfDay() }.sortedBy { it.start }; val lanes = mutableListOf<LocalDateTime>(); val placements = timed.map { o -> val lane = lanes.indexOfFirst { it <= o.start }.let { if (it < 0) lanes.size else it }; if (lane == lanes.size) lanes += o.end else lanes[lane] = o.end; o to lane }; val laneCount = lanes.size.coerceAtLeast(1)
                BoxWithConstraints(Modifier.weight(1f).height((24 * 48).dp).border(.3.dp, MaterialTheme.colorScheme.outlineVariant)) { repeat(24) { h -> HorizontalDivider(Modifier.offset(y = (h * 48).dp), thickness = .3.dp) }; placements.forEach { (o, lane) -> val from = maxOf(o.start, day.atStartOfDay()); val to = minOf(o.end, day.plusDays(1).atStartOfDay()); val y = (from.hour * 60 + from.minute) * .8f; val height = (Duration.between(from, to).toMinutes() * .8f).coerceAtLeast(20f); val color = eventColors[o.event.color] ?: eventColors.getValue("blue"); Text(o.event.title, Modifier.offset(x = maxWidth / laneCount * lane, y = y.dp).width(maxWidth / laneCount).height(height.dp).clip(RoundedCornerShape(3.dp)).background(color.copy(alpha = .22f)).clickable { onEvent(o) }.padding(2.dp), fontSize = 10.sp, lineHeight = 12.sp, overflow = TextOverflow.Ellipsis, textDecoration = if (o.cancelled) TextDecoration.LineThrough else null) } }
            }
        }
    }
}

@Composable private fun TrackingScreen(state: CalendarState, events: List<CalendarEvent>, onSelect: (NamedItem) -> Unit, onSettings: (CalendarSettings) -> Unit, onNew: (String) -> Unit) {
    var adding by remember { mutableStateOf(false) }; var name by remember { mutableStateOf("") }; var sorting by remember { mutableStateOf(false) }
    val statistics = remember(events, state.tracks) { state.tracks.associate { it.id to trackStatistics(it.id, events) } }
    val comparator = when (state.settings.sort) { "NAME" -> compareBy<NamedItem> { it.name }; "ELAPSED" -> compareBy { statistics[it.id]?.last?.end ?: LocalDateTime.MIN }; else -> compareBy { state.settings.manualOrder.indexOf(it.id).let { n -> if (n < 0) Int.MAX_VALUE else n } } }
    val list = state.tracks.filter { !it.archived && it.mergedInto == null }.sortedWith(if (state.settings.descending) comparator.reversed() else comparator).sortedByDescending { it.id in state.settings.pinned }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 90.dp)) {
        item { Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) { TextButton(onClick = { adding = true }) { Text("追跡を作成") }; Spacer(Modifier.weight(1f)); TextButton(onClick = { sorting = !sorting }) { Text("並び替え") } } }
        if (sorting) item { Row(Modifier.padding(horizontal = 8.dp)) { listOf("MANUAL" to "手動", "ELAPSED" to "経過日数", "NAME" to "名前").forEach { (v, label) -> FilterChip(state.settings.sort == v, { onSettings(state.settings.copy(sort = v)) }, label = { Text(label) }, modifier = Modifier.padding(end = 4.dp)) }; IconButton(onClick = { onSettings(state.settings.copy(descending = !state.settings.descending)) }) { Icon(if (state.settings.descending) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward, "昇順・降順") } } }
        if (list.isEmpty()) item { Text("予定に追跡を付けると、ここに履歴がまとまります。", Modifier.padding(20.dp)) }
        items(list, key = { it.id }) { track -> val stats = statistics.getValue(track.id); Card(onClick = { onSelect(track) }, modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 5.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) { Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) { Text(track.name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); IconButton(onClick = { onSettings(state.settings.copy(pinned = if (track.id in state.settings.pinned) state.settings.pinned - track.id else state.settings.pinned + track.id)) }, modifier = Modifier.size(36.dp)) { Icon(Icons.Default.PushPin, if (track.id in state.settings.pinned) "固定を解除" else "固定", tint = if (track.id in state.settings.pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline) } }
            Text(stats.last?.let { elapsedLabel(it.endDate) } ?: "記録なし", style = MaterialTheme.typography.headlineSmall)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp)) { Text("最後：${stats.last?.endDate?.format(dateFormat) ?: "—"}", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall); Text("今年 ${stats.yearCount}回", style = MaterialTheme.typography.bodyMedium) }
            if (sorting && state.settings.sort == "MANUAL") Row { TextButton(onClick = { val ids = list.map { it.id }.toMutableList(); val i = ids.indexOf(track.id); if (i > 0) { java.util.Collections.swap(ids, i, i - 1); onSettings(state.settings.copy(manualOrder = ids)) } }) { Text("上へ") }; TextButton(onClick = { val ids = list.map { it.id }.toMutableList(); val i = ids.indexOf(track.id); if (i < ids.lastIndex) { java.util.Collections.swap(ids, i, i + 1); onSettings(state.settings.copy(manualOrder = ids)) } }) { Text("下へ") } }
        } } }
    }
    if (adding) AlertDialog(onDismissRequest = { adding = false }, title = { Text("追跡を作成") }, text = { OutlinedTextField(name, { name = it }, label = { Text("追跡名") }) }, confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { onNew(name.trim()); name = ""; adding = false }) { Text("作成") } }, dismissButton = { TextButton(onClick = { adding = false }) { Text("戻る") } })
}
