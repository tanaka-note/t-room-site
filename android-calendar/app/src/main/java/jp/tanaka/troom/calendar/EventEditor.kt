@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package jp.tanaka.troom.calendar

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable fun EventEditor(state: CalendarState, existing: CalendarEvent?, selected: LocalDate, prefillTrack: String?, onDismiss: () -> Unit, reminderKey: String? = null, onDelete: (suspend () -> Boolean)? = null, onSave: suspend (CalendarEvent, List<String>, List<String>, List<Int>?) -> Boolean) {
    val base = remember { existing ?: CalendarEvent(title = "", start = selected.atStartOfDay(), end = selected.plusDays(1).atStartOfDay()) }
    var title by remember { mutableStateOf(base.title) }; var startDate by remember { mutableStateOf(base.start.toLocalDate()) }
    var endDate by remember { mutableStateOf(if (base.allDay) base.end.toLocalDate().minusDays(1) else base.end.toLocalDate()) }
    var allDay by remember { mutableStateOf(base.allDay) }; var startTime by remember { mutableStateOf(if (base.allDay) LocalTime.of(9, 0) else base.start.toLocalTime()) }
    var endTime by remember { mutableStateOf(if (base.allDay) LocalTime.of(9, 0).plusMinutes(state.settings.durationMinutes.toLong()) else base.end.toLocalTime()) }
    var endEdited by remember { mutableStateOf(existing != null) }
    var quickEntryEnabled by remember { mutableStateOf(existing == null) }
    val quickInput = remember(title, quickEntryEnabled) { if (quickEntryEnabled) parseEventTimeInput(title) else EventTimeInput(title.trim()) }
    var tracking by remember { mutableStateOf(base.trackIds.isNotEmpty() || prefillTrack != null) }
    var trackNames by remember { mutableStateOf(state.tracks.filter { it.id in base.trackIds || it.id == prefillTrack }.map { it.name }.toSet()) }
    var newTracks by remember { mutableStateOf("") }; var tagNames by remember { mutableStateOf(state.tags.filter { it.id in base.tagIds }.map { it.name }.toSet()) }
    var newTags by remember { mutableStateOf("") }; var color by remember { mutableStateOf(base.color) }
    var place by remember { mutableStateOf(base.place) }; var memo by remember { mutableStateOf(base.memo) }; var url by remember { mutableStateOf(base.url) }
    var repeat by remember { mutableStateOf(base.repeat) }
    val notificationKey = reminderKey ?: existing?.id ?: base.id
    var noticesOverride by remember { mutableStateOf(notificationKey in state.settings.eventReminders) }; var notices by remember { mutableStateOf(state.settings.eventReminders[notificationKey] ?: state.settings.minutesFor(base.id)) }
    var extras by remember { mutableStateOf(existing != null && (base.repeat.mode != "NONE" || base.tagIds.isNotEmpty() || base.place.isNotEmpty() || base.memo.isNotEmpty() || base.url.isNotEmpty() || noticesOverride)) }
    var excludedDates by remember { mutableStateOf(base.excludedDates) }
    var error by remember { mutableStateOf<String?>(null) }; var errorField by remember { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }; var discard by remember { mutableStateOf(false) }; var deleting by remember { mutableStateOf(false) }
    val titleFocus = remember { FocusRequester() }; val titleView = remember { BringIntoViewRequester() }; val dateView = remember { BringIntoViewRequester() }
    val trackView = remember { BringIntoViewRequester() }; val repeatView = remember { BringIntoViewRequester() }; val urlView = remember { BringIntoViewRequester() }
    val context = LocalContext.current; val scope = rememberCoroutineScope()
    fun pickDate(current: LocalDate, callback: (LocalDate) -> Unit) { DatePickerDialog(context, { _, y, m, d -> callback(LocalDate.of(y, m + 1, d)) }, current.year, current.monthValue - 1, current.dayOfMonth).show() }
    fun pickTime(current: LocalTime, callback: (LocalTime) -> Unit) { TimePickerDialog(context, { _, h, m -> callback(LocalTime.of(h, m)) }, current.hour, current.minute, true).show() }
    fun updateEnd() { if (!endEdited && !allDay) { val end = startDate.atTime(startTime).plusMinutes(state.settings.durationMinutes.toLong()); endDate = end.toLocalDate(); endTime = end.toLocalTime() } }
    fun applyQuickInput(value: EventTimeInput) { if (value.hasTime) { allDay = false; startTime = value.start!!; endTime = value.end!!; endDate = startDate.plusDays(if (value.endsNextDay) 1 else 0); endEdited = true } }
    fun commitQuickInput() { val input = if (quickEntryEnabled) parseEventTimeInput(title) else EventTimeInput(title.trim()); if (input.hasTime) { applyQuickInput(input); title = input.title } }
    fun failInput(field: String, message: String) {
        errorField = field; error = message
        if (field == "repeat" || field == "url") extras = true
    }
    fun close() { if (!saving) discard = true }
    Dialog(onDismissRequest = { close() }, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().height(56.dp).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = .55f)).padding(end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { close() }, enabled = !saving) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") }
                    Text(if (existing == null) "予定を追加" else "予定を編集", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                    Button(enabled = !saving, onClick = {
                        if (title.isBlank()) { failInput("title", "予定名を入力してください。"); return@Button }
                        val input = if (quickEntryEnabled) parseEventTimeInput(title) else EventTimeInput(title.trim())
                        input.error?.let { failInput("title", it); return@Button }
                        applyQuickInput(input)
                        val from = if (allDay) startDate.atStartOfDay() else startDate.atTime(startTime)
                        val through = if (allDay) endDate.plusDays(1).atStartOfDay() else endDate.atTime(endTime)
                        if (through <= from) { failInput("dates", "終了日時を開始日時より後にしてください。"); return@Button }
                        if (Duration.between(from, through) > Duration.ofDays(366)) { failInput("dates", "予定の長さは366日以内で指定してください。"); return@Button }
                        if (repeat.until != null && repeat.until!! < startDate) { failInput("repeat", "繰り返しの終了日は開始日以降にしてください。"); return@Button }
                        if (tracking && trackNames.isEmpty() && newTracks.isBlank()) { failInput("tracking", "追跡を選ぶか、新しい追跡名を入力してください。"); return@Button }
                        if (url.isNotBlank() && !url.startsWith("https://") && !url.startsWith("http://")) { failInput("url", "URLはhttps://またはhttp://で入力してください。"); return@Button }
                        val names = if (tracking) trackNames.toList() + newTracks.split('、', ',') else emptyList()
                        val tags = tagNames.toList() + newTags.split('、', ',')
                        val value = base.copy(title = input.title, start = from, end = through, allDay = allDay, color = color, place = place.trim(), memo = memo, url = url.trim(), repeat = repeat, excludedDates = excludedDates)
                        eventValidation(value)?.let { failInput("repeat", it); return@Button }
                        saving = true; error = null; errorField = ""
                        scope.launch { try { if (!onSave(value, names, tags, if (noticesOverride) notices else null)) error = "保存できませんでした。入力は保持しています。" } catch (e: Exception) { error = e.message ?: "保存できませんでした。" } finally { saving = false } }
                    }) { Text(if (saving) "保存中" else "保存") }
                }
                if (saving) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (errorField.isEmpty()) error?.let { Text(it, Modifier.fillMaxWidth().padding(10.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(title, { value -> title = value.take(200); quickEntryEnabled = true; applyQuickInput(parseEventTimeInput(title)); if (errorField == "title") { error = null; errorField = "" } }, modifier = Modifier.fillMaxWidth().focusRequester(titleFocus).bringIntoViewRequester(titleView), label = { Text("予定名・時刻（予定名は必須）") }, placeholder = { Text("例：$EVENT_TIME_INPUT_EXAMPLE") }, singleLine = true, isError = errorField == "title", supportingText = {
                        Text(if (errorField == "title") error.orEmpty() else if (quickInput.hasTime) "${quickInput.start}〜${if (quickInput.endsNextDay) "翌日" else ""}${quickInput.end} ／ 予定名：${quickInput.title}" else "例：$EVENT_TIME_INPUT_EXAMPLE\n時刻なしで予定名だけを入力することもできます。")
                    })
                    EditorSwitch("終日", allDay, !saving) { commitQuickInput(); allDay = it; if (!it) { endEdited = false; updateEnd() } }
                    Column(Modifier.fillMaxWidth().bringIntoViewRequester(dateView).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = .45f), RoundedCornerShape(14.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        EditorDateTime("開始", startDate, startTime, allDay, !saving, onDate = { commitQuickInput(); pickDate(startDate) { day -> val old = startDate; startDate = day; if (endDate == old) endDate = day; updateEnd() } }, onTime = { commitQuickInput(); pickTime(startTime) { startTime = it; updateEnd() } })
                        EditorDateTime("終了", endDate, endTime, allDay, !saving, onDate = { commitQuickInput(); pickDate(endDate) { endDate = it; endEdited = true } }, onTime = { commitQuickInput(); pickTime(endTime) { endTime = it; endEdited = true } })
                        if (errorField == "dates") Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    EventColorPicker(color) { color = it }
                    HorizontalDivider()
                    Column(Modifier.bringIntoViewRequester(trackView), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        EditorSwitch("追跡する（任意）", tracking, !saving) { tracking = it }
                        if (tracking) {
                            Text("予定名が違っても、同じ追跡で履歴にまとまります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { state.tracks.filter { it.mergedInto == null && (!it.archived || it.name in trackNames) }.forEach { item -> FilterChip(item.name in trackNames, { trackNames = if (item.name in trackNames) trackNames - item.name else trackNames + item.name }, label = { Text(item.name) }) } }
                            OutlinedTextField(newTracks, { newTracks = it.take(500) }, label = { Text("新しい追跡名") }, supportingText = { Text(if (errorField == "tracking") error.orEmpty() else "複数登録するときは「、」で区切ります") }, isError = errorField == "tracking", modifier = Modifier.fillMaxWidth())
                        }
                    }
                    HorizontalDivider()
                    TextButton(onClick = { extras = !extras }, modifier = Modifier.fillMaxWidth()) { Column(Modifier.weight(1f), horizontalAlignment = Alignment.Start) { Text("その他の設定"); Text("繰り返し・タグ・通知・場所・メモ・URL", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }; Icon(if (extras) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (extras) "その他の設定を閉じる" else "その他の設定を開く") }
                    if (extras) Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text("繰り返し", style = MaterialTheme.typography.labelLarge)
                        RepeatRuleFields(repeat, startDate, excludedDates, onRule = { repeat = it }, onExcludedDates = { excludedDates = it }, pickDate = { date, callback -> pickDate(date, callback) })
                        if (errorField == "repeat") Text(error.orEmpty(), modifier = Modifier.bringIntoViewRequester(repeatView), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        Text("タグ（任意）", style = MaterialTheme.typography.labelLarge)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) { state.tags.filter { it.mergedInto == null && (!it.archived || it.name in tagNames) }.forEach { item -> FilterChip(item.name in tagNames, { tagNames = if (item.name in tagNames) tagNames - item.name else tagNames + item.name }, label = { Text(item.name) }) } }
                        OutlinedTextField(newTags, { newTags = it.take(500) }, label = { Text("新しいタグ（複数は読点で区切る）") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(place, { place = it.take(500) }, label = { Text("場所") }, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(memo, { memo = it.take(20000) }, label = { Text("メモ") }, modifier = Modifier.fillMaxWidth(), minLines = 3)
                        OutlinedTextField(url, { url = it.take(2048) }, label = { Text("URL") }, modifier = Modifier.fillMaxWidth().bringIntoViewRequester(urlView), isError = errorField == "url", supportingText = if (errorField == "url") ({ Text(error.orEmpty()) }) else null)
                        EditorSwitch("この予定だけ通知を個別設定", noticesOverride, !saving) { noticesOverride = it }
                        if (noticesOverride) ReminderOptions(notices) { notices = it } else Text(if (state.settings.reminders.isEmpty()) "標準設定：通知なし" else "標準の通知設定を使用", style = MaterialTheme.typography.bodySmall)
                    }
                    if (existing != null && onDelete != null) TextButton(enabled = !saving, onClick = { deleting = true }) { Text("この予定全体をゴミ箱へ移す") }
                    Spacer(Modifier.height(12.dp))
                }
            }
        }
        LaunchedEffect(error, errorField) {
            if (error != null) when (errorField) { "title" -> { titleFocus.requestFocus(); titleView.bringIntoView() }; "dates" -> dateView.bringIntoView(); "tracking" -> trackView.bringIntoView(); "repeat" -> repeatView.bringIntoView(); "url" -> urlView.bringIntoView() }
        }
        BackHandler { close() }
        if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("編集を終了しますか？") }, text = { Text("保存していない入力は破棄されます。") }, confirmButton = { TextButton(onClick = onDismiss) { Text("破棄して戻る") } }, dismissButton = { TextButton(onClick = { discard = false }) { Text("編集を続ける") } })
        if (deleting) AlertDialog(onDismissRequest = { if (!saving) deleting = false }, title = { Text("予定全体をゴミ箱へ移しますか？") }, text = { Text("編集中の内容は保存せず、繰り返しを含むこの予定全体を移します。30日以内は復元できます。") }, confirmButton = { TextButton(enabled = !saving, onClick = { saving = true; scope.launch { try { if (onDelete?.invoke() == true) onDismiss() else error = "削除できませんでした。" } finally { saving = false; deleting = false } } }) { Text("ゴミ箱へ移す") } }, dismissButton = { TextButton(enabled = !saving, onClick = { deleting = false }) { Text("戻る") } })
    }
}

@Composable private fun EditorSwitch(label: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange), verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(checked, onCheckedChange = null, enabled = enabled) }
}

@Composable private fun EditorDateTime(label: String, date: LocalDate, time: LocalTime, allDay: Boolean, enabled: Boolean, onDate: () -> Unit, onTime: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        OutlinedButton(onClick = onDate, enabled = enabled, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp)) { Icon(Icons.Default.CalendarMonth, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(date.format(DateTimeFormatter.ofPattern("yyyy年M月d日(E)", Locale.JAPAN)), Modifier.weight(1f)); Icon(Icons.Default.Edit, "${label}日を変更", Modifier.size(16.dp)) }
        if (!allDay) OutlinedButton(onClick = onTime, enabled = enabled, modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp)) { Icon(Icons.Default.Schedule, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(time.format(DateTimeFormatter.ofPattern("HH:mm")), Modifier.weight(1f)); Icon(Icons.Default.Edit, "${label}時刻を変更", Modifier.size(16.dp)) }
    }
}

@Composable private fun RepeatRuleFields(repeat: RepeatRule, startDate: LocalDate, excludedDates: Set<LocalDate>, onRule: (RepeatRule) -> Unit, onExcludedDates: (Set<LocalDate>) -> Unit, pickDate: (LocalDate, (LocalDate) -> Unit) -> Unit) {
    var ruleOpen by remember { mutableStateOf(false) }
    ChoiceField(repeat.label(), listOf("NONE" to "繰り返さない", "DAILY" to "毎日・N日ごと", "WEEKLY" to "毎週・隔週・指定曜日", "MONTHLY" to "毎月・月末・第N曜日", "YEARLY" to "毎年", "DATES" to "日付を個別に指定")) { mode -> onRule(repeat.copy(mode = mode, weekdays = if (mode == "WEEKLY" && repeat.weekdays.isEmpty()) setOf(startDate.dayOfWeek.value) else repeat.weekdays)); ruleOpen = mode != "NONE" }
    if (repeat.mode != "NONE") TextButton(onClick = { ruleOpen = !ruleOpen }) { Text(if (ruleOpen) "繰り返し詳細を閉じる" else "繰り返し詳細") }
    if (ruleOpen && repeat.mode != "NONE") {
        if (repeat.mode != "DATES") OutlinedTextField(repeat.interval.toString(), { value -> value.toIntOrNull()?.takeIf { it in 1..100 }?.let { onRule(repeat.copy(interval = it)) } }, label = { Text("間隔（${when (repeat.mode) { "DAILY" -> "日"; "WEEKLY" -> "週"; "MONTHLY" -> "か月"; else -> "年" }}）") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (repeat.mode == "WEEKLY") FlowRow { (1..7).forEach { day -> FilterChip(day in repeat.weekdays, { val next = if (day in repeat.weekdays) repeat.weekdays - day else repeat.weekdays + day; if (next.isNotEmpty()) onRule(repeat.copy(weekdays = next)) }, label = { Text(listOf("月", "火", "水", "木", "金", "土", "日")[day - 1]) }, modifier = Modifier.padding(end = 3.dp)) } }
        if (repeat.mode == "MONTHLY") ChoiceField(when (repeat.monthly) { "LAST" -> "月末"; "NTH" -> "開始日と同じ第N曜日"; "LAST_WEEKDAY" -> "開始日と同じ曜日の最終週"; else -> "指定日・なければ月末" }, listOf("DAY" to "指定日・なければ月末", "LAST" to "月末", "NTH" to "開始日と同じ第N曜日", "LAST_WEEKDAY" to "開始日と同じ曜日の最終週")) { onRule(repeat.copy(monthly = it)) }
        if (repeat.mode == "DATES") { FlowRow { repeat.dates.forEach { date -> InputChip(true, onClick = { onRule(repeat.copy(dates = repeat.dates - date)) }, label = { Text("$date ×") }) } }; TextButton(onClick = { pickDate(startDate) { onRule(repeat.copy(dates = (repeat.dates + it).distinct().sorted())) } }) { Text("日付を追加") } }
        ChoiceField(if (repeat.until != null) "${repeat.until}まで" else if (repeat.count != null) "${repeat.count}回" else "終了なし", listOf("NONE" to "終了なし", "UNTIL" to "終了日を選ぶ", "COUNT" to "回数を指定")) { when (it) { "NONE" -> onRule(repeat.copy(until = null, count = null)); "UNTIL" -> pickDate(repeat.until ?: startDate.plusMonths(1)) { day -> onRule(repeat.copy(until = day, count = null)) }; else -> onRule(repeat.copy(until = null, count = 10)) } }
        if (repeat.count != null) OutlinedTextField(repeat.count.toString(), { v -> v.toIntOrNull()?.takeIf { it in 1..10000 }?.let { onRule(repeat.copy(count = it)) } }, label = { Text("繰り返す回数") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        FlowRow { excludedDates.sorted().forEach { date -> InputChip(true, onClick = { onExcludedDates(excludedDates - date) }, label = { Text("除外 $date ×") }) } }; TextButton(onClick = { pickDate(startDate) { onExcludedDates(excludedDates + it) } }) { Text("除外する日を追加") }
    }
}
