@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package jp.tanaka.troom.calendar

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable fun TrackingDetail(track: NamedItem, state: CalendarState, events: List<CalendarEvent>, onBack: () -> Unit, onAdd: () -> Unit, onCalendar: () -> Unit, onEvent: (Occurrence) -> Unit, onEdit: (NamedItem) -> Unit, onMerge: (NamedItem, NamedItem) -> Unit) {
    var year by remember(track.id) { mutableIntStateOf(today().year) }; var edit by remember { mutableStateOf(false) }; var merge by remember { mutableStateOf(false) }
    val stats = remember(track.id, year, events) { trackStatistics(track.id, events, year = year) }
    val format = DateTimeFormatter.ofPattern("M月d日(E)", Locale.JAPAN)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp, 4.dp, 12.dp, 90.dp)) {
        item { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "追跡一覧へ戻る") }; Text(track.name, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge); IconButton(onClick = { edit = true }) { Icon(Icons.Default.Edit, "追跡を編集") } } }
        item { Text(stats.last?.let { elapsedLabel(it.endDate) } ?: "記録なし", style = MaterialTheme.typography.headlineMedium); Text("最後：${stats.last?.endDate?.format(format) ?: "—"}", style = MaterialTheme.typography.bodySmall); if (track.targetDays != null && stats.last != null) { val target = stats.last.endDate.plusDays(track.targetDays.toLong()); Text("次回の目安：${target.format(format)}", Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.primary) } }
        item { FlowRow(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilledTonalButton(onClick = onAdd) { Text("この追跡で予定を追加") }; OutlinedButton(onClick = onCalendar) { Text("カレンダーで見る") } } }
        item { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { IconButton(onClick = { year-- }) { Icon(Icons.Default.ChevronLeft, "前年") }; Text("${year}年 ${stats.yearCount}回", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); IconButton(onClick = { year++ }) { Icon(Icons.Default.ChevronRight, "翌年") } } }
        if (stats.history.isEmpty()) item { Text("この年の記録はありません", Modifier.padding(12.dp)) }
        items(stats.history, key = { it.key }) { row -> val index = stats.history.indexOf(row); val older = stats.history.getOrNull(index + 1)
            Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) { Text(row.endDate.format(format) + "・今年${stats.history.size - index}回目" + (older?.let { "・前回から${java.time.temporal.ChronoUnit.DAYS.between(it.endDate, row.endDate)}日" } ?: ""), style = MaterialTheme.typography.labelMedium); EventRow(row, onEvent) }
        }
        item { TextButton(onClick = { merge = true }) { Text("別の追跡へ統合") }; TextButton(onClick = { onEdit(track.copy(archived = !track.archived)) }) { Text(if (track.archived) "アーカイブから復元" else "アーカイブへ移す") } }
    }
    if (edit) NamedItemDialog("追跡を編集", track, true, onDismiss = { edit = false }, onSave = { onEdit(it); edit = false })
    if (merge) MergeDialog("追跡", track, state.tracks, onDismiss = { merge = false }, onMerge = { onMerge(track, it); merge = false })
}

@Composable fun EventDetail(item: Occurrence, state: CalendarState, onDismiss: () -> Unit, onEdit: (Occurrence) -> Unit, onChange: (Occurrence, String) -> Unit) {
    val context = LocalContext.current; var deleting by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(20.dp).navigationBarsPadding()) {
            Text(item.event.title, style = MaterialTheme.typography.headlineSmall)
            Text(if (item.event.allDay) "${item.start.toLocalDate()}〜${item.end.toLocalDate().minusDays(1)}・終日" else "${item.start.toString().replace('T', ' ')}〜${item.end.toString().replace('T', ' ')}", Modifier.padding(top = 10.dp))
            if (item.cancelled) Text("中止", color = MaterialTheme.colorScheme.error)
            if (item.series.repeat.mode != "NONE") Text(item.series.repeat.label(), Modifier.padding(top = 6.dp))
            val tracking = state.tracks.filter { it.id in item.event.trackIds }.joinToString { it.name }
            if (tracking.isNotBlank()) Text("追跡：$tracking", Modifier.padding(top = 8.dp))
            val tags = state.tags.filter { it.id in item.event.tagIds }.joinToString { it.name }; if (tags.isNotBlank()) Text("タグ：$tags", Modifier.padding(top = 6.dp))
            if (item.event.place.isNotBlank()) Text("場所：${item.event.place}", Modifier.padding(top = 8.dp))
            if (item.event.memo.isNotBlank()) Text(item.event.memo, Modifier.padding(top = 12.dp))
            if (item.event.url.startsWith("https://") || item.event.url.startsWith("http://")) TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.event.url))) } }) { Text(item.event.url) }
            FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { Button(onClick = { onEdit(item) }) { Text("編集") }; OutlinedButton(onClick = { onChange(item, "cancel") }) { Text(if (item.cancelled) "中止を解除" else "中止") }; TextButton(onClick = { deleting = true }) { Text("削除") } }
        }
    }
    if (deleting) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("予定を削除") }, text = { Text(if (item.series.repeat.mode == "NONE") "ゴミ箱へ移します。30日以内は復元できます。" else "この回を削除します。繰り返し全体の削除は編集画面から行えます。") }, confirmButton = { TextButton(onClick = { deleting = false; onChange(item, "delete") }) { Text("削除") } }, dismissButton = { TextButton(onClick = { deleting = false }) { Text("戻る") } })
}

@Composable fun NamedItemDialog(title: String, value: NamedItem, target: Boolean, onDismiss: () -> Unit, onSave: (NamedItem) -> Unit) {
    var name by remember { mutableStateOf(value.name) }; var days by remember { mutableStateOf(value.targetDays?.toString().orEmpty()) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = { Column { OutlinedTextField(name, { name = it.take(100) }, label = { Text("名前") }, singleLine = true); if (target) OutlinedTextField(days, { days = it.filter(Char::isDigit).take(5) }, label = { Text("前回から何日後を目安にするか（任意）") }, modifier = Modifier.padding(top = 8.dp), singleLine = true) } }, confirmButton = { TextButton(enabled = name.isNotBlank() && (days.isBlank() || days.toIntOrNull() in 1..36500), onClick = { onSave(value.copy(name = name.trim(), targetDays = days.toIntOrNull())) }) { Text("保存") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("戻る") } })
}

@Composable fun MergeDialog(label: String, source: NamedItem, all: List<NamedItem>, onDismiss: () -> Unit, onMerge: (NamedItem) -> Unit) {
    var selected by remember { mutableStateOf<NamedItem?>(null) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("${label}を統合") }, text = { Column { Text("「${source.name}」を選択した項目へ統合します。同じ予定の関連は1つにまとまります。"); all.filter { it.id != source.id && it.mergedInto == null && !it.archived }.forEach { item -> Row(Modifier.fillMaxWidth().clickable { selected = item }, verticalAlignment = Alignment.CenterVertically) { RadioButton(selected?.id == item.id, onClick = { selected = item }); Text(item.name) } } } }, confirmButton = { TextButton(enabled = selected != null, onClick = { selected?.let(onMerge) }) { Text("統合") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("戻る") } })
}

@Composable fun SettingsScreen(state: CalendarState, model: MainViewModel, activity: MainActivity, drawerOpen: Boolean = false) {
    var view by remember { mutableStateOf("settings") }; var editItem by remember { mutableStateOf<Pair<String, NamedItem>?>(null) }; var mergeItem by remember { mutableStateOf<Pair<String, NamedItem>?>(null) }
    var permanentlyDeleting by remember { mutableStateOf<TrashEntry?>(null) }
    androidx.activity.compose.BackHandler(view != "settings" && !drawerOpen) { view = "settings" }
    val scope = rememberCoroutineScope(); val settings = state.settings
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.repository.rebuildReminders() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(14.dp, 6.dp, 14.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (view == "settings") {
            item { Text(state.account?.name.orEmpty(), style = MaterialTheme.typography.titleMedium) }
            item { Text("配色", style = MaterialTheme.typography.titleSmall); FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("blue" to "ブルー", "mint" to "ミント", "lavender" to "ラベンダー").forEach { (value, label) -> FilterChip(settings.theme == value, onClick = { model.settings(settings.copy(theme = value)) }, label = { Text(label) }) } } }
            item { Text("起動時の画面", style = MaterialTheme.typography.titleSmall); ChoiceField(CalendarPage.entries.firstOrNull { it.name == settings.startPage }?.label ?: "月間カレンダー", CalendarPage.entries.map { it.name to it.label }) { model.settings(settings.copy(startPage = it)) } }
            item { Text("予定の初期の長さ", style = MaterialTheme.typography.titleSmall); ChoiceField("${settings.durationMinutes}分", listOf(15, 30, 60, 90, 120, 180).map { it.toString() to "${it}分" }) { model.settings(settings.copy(durationMinutes = it.toInt())) } }
            item { HorizontalDivider(); Text("標準の通知", Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleSmall); Text("終日予定は開始日の0:00を基準にします。", style = MaterialTheme.typography.bodySmall); ReminderOptions(settings.reminders) { model.settings(settings.copy(reminders = it)) } }
            item { if (!ReminderScheduler.permitted(activity)) Column { Text("通知を利用するには、通知と「アラームとリマインダー」の許可が必要です。", style = MaterialTheme.typography.bodySmall); Row { TextButton(onClick = { permissions.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("通知を許可") }; TextButton(onClick = { activity.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${activity.packageName}"))) }) { Text("時刻の予約を許可") } } } else Text("通知の許可：有効", color = MaterialTheme.colorScheme.primary) }
            item { HorizontalDivider(); Text(if (state.account?.localOnly == true) "この端末で利用中" else "オフライン保存", Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleSmall); ChoiceField("上限 ${settings.cacheMiB}MiB", listOf(50, 100, 200, 500).map { it.toString() to "${it}MiB" }) { model.settings(settings.copy(cacheMiB = it.toInt())) }; Text(if (state.account?.localOnly == true) "予定はこの端末内に保存されます。端末間の同期とサーバーへのバックアップは行いません。" else "取得済みの予定を圏外でも利用できます。通知に必要な情報と未同期の変更は保護します。", style = MaterialTheme.typography.bodySmall); Text("保存上限は、端末内の予定とサーバーから取得済みのデータの合計です。", style = MaterialTheme.typography.bodySmall); if (state.account?.localOnly != true) { Text("未同期：${state.pending.size}件", style = MaterialTheme.typography.bodySmall); TextButton(onClick = { model.sync() }) { Text("今すぐ同期") } } }
            item { HorizontalDivider(); TextButton(onClick = { view = "archives" }) { Text("アーカイブした追跡") }; TextButton(onClick = { view = "tags" }) { Text("タグを管理") }; TextButton(onClick = { view = "trash" }) { Text("ゴミ箱（30日）") } }
            item { HorizontalDivider(); Text("バージョン ${BuildConfig.VERSION_NAME}／Android 14以上", style = MaterialTheme.typography.bodySmall); TextButton(onClick = { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html"))) }) { Text("祝日データ：内閣府（2027年まで）") } }
        } else {
            item { TextButton(onClick = { view = "settings" }) { Text("← 設定へ戻る") }; Text(when (view) { "archives" -> "アーカイブした追跡"; "tags" -> "タグ管理"; else -> "ゴミ箱" }, style = MaterialTheme.typography.titleLarge) }
            if (view == "trash") {
                val deleted = trashEntries(state.events)
                if (deleted.isEmpty()) item { Text("ゴミ箱は空です") }
                items(deleted, key = { it.key }) { entry -> Column { Text(entry.title); Text(entry.anchor ?: entry.series.start.toLocalDate().toString(), style = MaterialTheme.typography.bodySmall); Row { TextButton(enabled = System.currentTimeMillis() - entry.deletedAt < 30L * 86400000, onClick = { scope.launch { model.saveEvent(entry.restore()) } }) { Text("復元") }; TextButton(onClick = { permanentlyDeleting = entry }) { Text("完全削除") } } } }
            } else {
                val kind = if (view == "archives") "track" else "tag"
                val list = state.named(kind).filter { it.mergedInto == null && (view != "archives" || it.archived) }
                if (list.isEmpty()) item { Text("項目はありません") }
                items(list, key = { it.id }) { item -> Column { Text(item.name, style = MaterialTheme.typography.titleMedium); FlowRow { TextButton(onClick = { editItem = kind to item }) { Text("編集") }; if (view == "archives") TextButton(onClick = { model.named(kind, item.copy(archived = false)) }) { Text("復元") } else { TextButton(onClick = { model.named(kind, item.copy(archived = !item.archived)) }) { Text(if (item.archived) "復元" else "アーカイブ") }; TextButton(onClick = { mergeItem = kind to item }) { Text("統合") } } } } }
            }
        }
    }
    editItem?.let { (kind, item) -> NamedItemDialog("名前を編集", item, kind == "track", onDismiss = { editItem = null }, onSave = { model.named(kind, it); editItem = null }) }
    mergeItem?.let { (kind, item) -> MergeDialog(if (kind == "tag") "タグ" else "追跡", item, state.named(kind), onDismiss = { mergeItem = null }, onMerge = { target -> scope.launch { model.merge(kind, item, target); mergeItem = null } }) }
    permanentlyDeleting?.let { entry -> AlertDialog(onDismissRequest = { permanentlyDeleting = null }, title = { Text("完全に削除しますか？") }, text = { Text("「${entry.title}」は通常の画面へ戻せません。取得済みバックアップには保持期限まで残ります。") }, confirmButton = { TextButton(onClick = { scope.launch { if (model.repository.save("event", entry.series.id, entry.purge())) { model.sync(); permanentlyDeleting = null } } }) { Text("完全削除") } }, dismissButton = { TextButton(onClick = { permanentlyDeleting = null }) { Text("戻る") } }) }
}

@Composable fun ChoiceField(value: String, choices: List<Pair<String, String>>, onChoose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box { OutlinedButton(onClick = { expanded = true }) { Text(value); Icon(Icons.Default.ArrowDropDown, null) }; DropdownMenu(expanded, { expanded = false }) { choices.forEach { (key, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { onChoose(key); expanded = false }) } } }
}

@Composable fun ReminderOptions(minutes: List<Int>, onChange: (List<Int>) -> Unit) {
    var custom by remember { mutableStateOf("") }; var unit by remember { mutableStateOf("60") }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf(0 to "開始時", 10 to "10分前", 30 to "30分前", 60 to "1時間前", 1440 to "1日前").forEach { (offset, label) -> FilterChip(offset in minutes, { onChange(if (offset in minutes) minutes - offset else (minutes + offset).distinct().sorted()) }, label = { Text(label) }) }; FilterChip(minutes.isEmpty(), { onChange(emptyList()) }, label = { Text("通知なし") }) }
    minutes.filter { it !in listOf(0, 10, 30, 60, 1440) }.forEach { value -> InputChip(true, onClick = { onChange(minutes - value) }, label = { Text("${if (value % 1440 == 0) "${value / 1440}日前" else if (value % 60 == 0) "${value / 60}時間前" else "${value}分前"} ×") }) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) { OutlinedTextField(custom, { custom = it.filter(Char::isDigit).take(5) }, label = { Text("指定") }, modifier = Modifier.weight(1f), singleLine = true); ChoiceField(when (unit) { "1440" -> "日前"; "60" -> "時間前"; else -> "分前" }, listOf("1" to "分前", "60" to "時間前", "1440" to "日前")) { unit = it }; TextButton(enabled = custom.toIntOrNull()?.let { it.toLong() * unit.toInt() in 0..525600 } == true && minutes.size < 10, onClick = { val next = custom.toInt() * unit.toInt(); onChange((minutes + next).distinct().sorted()); custom = "" }) { Text("追加") } }
}
