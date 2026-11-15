package jp.tanaka.troom.calendar

import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.time.temporal.ChronoUnit
import java.util.UUID

val JAPAN: ZoneId = ZoneId.of("Asia/Tokyo")
fun today(): LocalDate = LocalDate.now(JAPAN)
fun nowJapan(): LocalDateTime = LocalDateTime.now(JAPAN)
fun newId(): String = UUID.randomUUID().toString()
fun JSONObject.strings(name: String): List<String> = optJSONArray(name)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
fun JSONObject.ints(name: String): List<Int> = optJSONArray(name)?.let { a -> (0 until a.length()).map { a.getInt(it) } } ?: emptyList()
fun JSONObject.optionalLong(name: String): Long? = if (has(name) && !isNull(name)) getLong(name) else null

data class Entity(val kind: String, val id: String, val body: JSONObject, val version: Int = 0, val purged: Boolean = false) {
    val key get() = "$kind:$id"
    fun json() = JSONObject().put("kind", kind).put("id", id).put("payload", body).put("version", version).put("purged", purged)
    companion object { fun parse(v: JSONObject) = Entity(v.getString("kind"), v.getString("id"), v.optJSONObject("payload") ?: JSONObject(), v.optInt("version"), v.optBoolean("purged")) }
}

data class RepeatRule(
    val mode: String = "NONE", val interval: Int = 1, val weekdays: Set<Int> = emptySet(),
    val monthly: String = "DAY", val until: LocalDate? = null, val count: Int? = null,
    val dates: List<LocalDate> = emptyList(),
) {
    fun json() = JSONObject().put("mode", mode).put("interval", interval).put("weekdays", JSONArray(weekdays.sorted()))
        .put("monthly", monthly).put("until", until?.toString() ?: JSONObject.NULL).put("count", count ?: JSONObject.NULL)
        .put("dates", JSONArray(dates.map { it.toString() }))
    fun label(): String = when (mode) {
        "DAILY" -> if (interval == 1) "毎日" else "${interval}日ごと"
        "WEEKLY" -> (if (interval == 1) "毎週" else "${interval}週ごと") + weekdays.sorted().joinToString("・", " ") { listOf("月", "火", "水", "木", "金", "土", "日")[it - 1] }
        "MONTHLY" -> (if (interval == 1) "毎月" else "${interval}か月ごと") + when (monthly) { "LAST" -> "・月末"; "NTH" -> "・第N曜日"; "LAST_WEEKDAY" -> "・最終曜日"; else -> "・指定日（なければ月末）" }
        "YEARLY" -> if (interval == 1) "毎年" else "${interval}年ごと"
        "DATES" -> "日付を指定"
        else -> "繰り返さない"
    }
    companion object {
        fun parse(v: JSONObject?) = if (v == null) RepeatRule() else RepeatRule(v.optString("mode", "NONE"), v.optInt("interval", 1).coerceIn(1, 100), v.ints("weekdays").filter { it in 1..7 }.toSet(), v.optString("monthly", "DAY"), v.optString("until").takeIf { it.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) }?.let(LocalDate::parse), v.optionalLong("count")?.toInt(), v.strings("dates").map(LocalDate::parse))
    }
}

data class CalendarEvent(
    val id: String = newId(), val title: String, val start: LocalDateTime, val end: LocalDateTime,
    val allDay: Boolean = true, val trackIds: Set<String> = emptySet(), val tagIds: Set<String> = emptySet(),
    val color: String = "blue", val place: String = "", val memo: String = "", val url: String = "",
    val cancelled: Boolean = false, val deletedAt: Long? = null, val repeat: RepeatRule = RepeatRule(),
    val exceptions: Map<String, JSONObject> = emptyMap(), val excludedDates: Set<LocalDate> = emptySet(),
    val revision: Int? = null,
) {
    fun json(): JSONObject {
        val overrides = JSONObject(); exceptions.forEach { (k, v) -> overrides.put(k, v) }
        return JSONObject().put("id", id).put("title", title).put("start", start.toString()).put("end", end.toString()).put("allDay", allDay)
            .put("trackIds", JSONArray(trackIds.toList())).put("tagIds", JSONArray(tagIds.toList())).put("color", color)
            .put("place", place).put("memo", memo).put("url", url).put("cancelled", cancelled)
            .put("deletedAt", deletedAt ?: JSONObject.NULL).put("repeat", repeat.json()).put("exceptions", overrides)
            .put("excludedDates", JSONArray(excludedDates.map { it.toString() }))
    }
    fun occurrences(from: LocalDate, through: LocalDate, limit: Int = 10000): List<Occurrence> {
        if (through < from) return emptyList()
        val duration = Duration.between(start, end)
        val span = duration.toDays().coerceAtLeast(0)
        val candidates = mutableListOf<LocalDate>()
        if (repeat.mode == "NONE") candidates += start.toLocalDate()
        else if (repeat.mode == "DATES") candidates += (repeat.dates + start.toLocalDate()).distinct().sorted()
        else {
            var day = if (repeat.count != null) start.toLocalDate() else maxOf(start.toLocalDate(), from.minusDays(span + 1))
            val stop = minOf(through, repeat.until ?: through)
            var examined = 0
            while (day <= stop && examined++ < 200000) {
                if (matches(day)) candidates += day
                if (repeat.count != null && candidates.size >= repeat.count) break
                day = day.plusDays(1)
            }
        }
        val ordered = candidates.filter { repeat.until == null || it <= repeat.until }.take(repeat.count ?: Int.MAX_VALUE)
        val moved = exceptions.filterValues { it.has("replacement") }.keys.mapNotNull { runCatching { LocalDate.parse(it) }.getOrNull() }
            .filter { anchor -> anchor >= start.toLocalDate() && (repeat.until == null || anchor <= repeat.until) && when (repeat.mode) {
                "NONE" -> anchor == start.toLocalDate()
                "DATES" -> anchor in (repeat.dates + start.toLocalDate()).distinct().sorted().take(repeat.count ?: Int.MAX_VALUE)
                else -> matches(anchor) && (repeat.count == null || generateSequence(start.toLocalDate()) { it.plusDays(1) }.takeWhile { it <= anchor }.take(200000).filter(::matches).take(repeat.count).any { it == anchor })
            } }
        return (ordered + moved).distinct().sorted().asSequence().filter { it !in excludedDates }
            .map { day ->
                val anchor = day.toString()
                val override = exceptions[anchor]
                val replacement = override?.optJSONObject("replacement")?.let { parse(it) }
                val instanceStart = replacement?.start ?: day.atTime(start.toLocalTime())
                val instanceEnd = replacement?.end ?: instanceStart.plus(duration)
                Occurrence(this, anchor, replacement ?: this, instanceStart, instanceEnd, cancelled || override?.optBoolean("cancelled") == true || replacement?.cancelled == true, deletedAt != null || override?.optBoolean("deleted") == true || replacement?.deletedAt != null)
            }.filter { it.start.toLocalDate() <= through && it.end > from.atStartOfDay() }.take(limit).toList()
    }
    private fun matches(day: LocalDate): Boolean {
        val first = start.toLocalDate(); if (day < first) return false
        return when (repeat.mode) {
            "DAILY" -> ChronoUnit.DAYS.between(first, day) % repeat.interval == 0L
            "WEEKLY" -> {
                val weekStart = first.minusDays((first.dayOfWeek.value % 7).toLong())
                (ChronoUnit.DAYS.between(weekStart, day) / 7) % repeat.interval == 0L && day.dayOfWeek.value in repeat.weekdays.ifEmpty { setOf(first.dayOfWeek.value) }
            }
            "MONTHLY" -> ChronoUnit.MONTHS.between(YearMonth.from(first), YearMonth.from(day)) % repeat.interval == 0L && when (repeat.monthly) {
                "LAST" -> day.dayOfMonth == day.lengthOfMonth()
                "NTH" -> day.dayOfWeek == first.dayOfWeek && (day.dayOfMonth - 1) / 7 == (first.dayOfMonth - 1) / 7
                "LAST_WEEKDAY" -> day.dayOfWeek == first.dayOfWeek && day.plusWeeks(1).month != day.month
                else -> day.dayOfMonth == minOf(first.dayOfMonth, day.lengthOfMonth())
            }
            "YEARLY" -> (day.year - first.year) % repeat.interval == 0 && day.month == first.month && day.dayOfMonth == minOf(first.dayOfMonth, day.lengthOfMonth())
            else -> false
        }
    }
    companion object {
        fun parse(v: JSONObject): CalendarEvent {
            val overrides = v.optJSONObject("exceptions") ?: JSONObject()
            return CalendarEvent(v.getString("id"), v.getString("title"), LocalDateTime.parse(v.getString("start")), LocalDateTime.parse(v.getString("end")), v.optBoolean("allDay", true), v.strings("trackIds").toSet(), v.strings("tagIds").toSet(), v.optString("color", "blue"), v.optString("place"), v.optString("memo"), v.optString("url"), v.optBoolean("cancelled"), v.optionalLong("deletedAt"), RepeatRule.parse(v.optJSONObject("repeat")), overrides.keys().asSequence().associateWith { overrides.getJSONObject(it) }, v.strings("excludedDates").map(LocalDate::parse).toSet())
        }
    }
}

data class Occurrence(val series: CalendarEvent, val anchor: String, val event: CalendarEvent, val start: LocalDateTime, val end: LocalDateTime, val cancelled: Boolean, val deleted: Boolean) {
    val key get() = "${series.id}@$anchor"
    val endDate get() = if (event.allDay) end.toLocalDate().minusDays(1) else end.toLocalDate()
    fun eligible(now: LocalDateTime = nowJapan()) = !cancelled && !deleted && end <= now
}

data class TrashEntry(val series: CalendarEvent, val anchor: String?, val title: String, val deletedAt: Long) {
    val key get() = series.id + (anchor ?: "")
    fun restore(): CalendarEvent {
        if (anchor == null) return series.copy(deletedAt = null)
        val value = JSONObject(series.exceptions.getValue(anchor).toString()).apply { remove("deleted"); remove("deletedAt") }
        return series.copy(exceptions = if (value.length() == 0) series.exceptions - anchor else series.exceptions + (anchor to value))
    }
    fun purge() = if (anchor == null) JSONObject().put("id", series.id).put("purged", true) else series.copy(exceptions = series.exceptions + (anchor to JSONObject().put("deleted", true))).json()
}
fun trashEntries(events: List<CalendarEvent>): List<TrashEntry> = events.flatMap { e ->
    if (e.deletedAt != null) listOf(TrashEntry(e, null, e.title, e.deletedAt)) else e.exceptions.mapNotNull { (anchor, v) -> if (v.optBoolean("deleted") && v.optionalLong("deletedAt") != null) TrashEntry(e, anchor, v.optJSONObject("replacement")?.optString("title") ?: e.title, v.getLong("deletedAt")) else null }
}.sortedByDescending { it.deletedAt }

data class NamedItem(val id: String = newId(), val name: String, val archived: Boolean = false, val mergedInto: String? = null, val targetDays: Int? = null, val revision: Int? = null) {
    fun json() = JSONObject().put("id", id).put("name", name).put("archived", archived).put("mergedInto", mergedInto ?: JSONObject.NULL).put("targetDays", targetDays ?: JSONObject.NULL)
    companion object { fun parse(v: JSONObject) = NamedItem(v.getString("id"), v.getString("name"), v.optBoolean("archived"), v.optString("mergedInto").takeUnless { it.isBlank() || it == "null" }, v.optionalLong("targetDays")?.toInt()) }
}

data class CalendarSettings(
    val theme: String = "blue", val startPage: String = "MONTH", val durationMinutes: Int = 60,
    val reminders: List<Int> = emptyList(), val eventReminders: Map<String, List<Int>> = emptyMap(),
    val pinned: List<String> = emptyList(), val manualOrder: List<String> = emptyList(),
    val sort: String = "MANUAL", val descending: Boolean = false, val cacheMiB: Int = 100,
) {
    fun minutesFor(id: String, anchor: String? = null) = anchor?.let { eventReminders["$id@$it"] } ?: eventReminders[id] ?: reminders
    fun json(): JSONObject {
        val overrides = JSONObject(); eventReminders.forEach { (k, v) -> overrides.put(k, JSONArray(v)) }
        return JSONObject().put("theme", theme).put("startPage", startPage).put("durationMinutes", durationMinutes)
            .put("reminders", JSONArray(reminders)).put("eventReminders", overrides).put("pinned", JSONArray(pinned))
            .put("manualOrder", JSONArray(manualOrder)).put("sort", sort).put("descending", descending).put("cacheMiB", cacheMiB)
    }
    companion object {
        fun parse(v: JSONObject): CalendarSettings {
            val overrides = v.optJSONObject("eventReminders") ?: JSONObject()
            return CalendarSettings(v.optString("theme", "blue"), v.optString("startPage", "MONTH"), v.optInt("durationMinutes", 60), v.ints("reminders"), overrides.keys().asSequence().associateWith { overrides.ints(it) }, v.strings("pinned"), v.strings("manualOrder"), v.optString("sort", "MANUAL"), v.optBoolean("descending"), v.optInt("cacheMiB", 100).coerceIn(20, 500))
        }
    }
}

data class TrackStats(val last: Occurrence?, val yearCount: Int, val history: List<Occurrence>)
fun eventValidation(e: CalendarEvent): String? = when {
    e.title.isBlank() || e.title.length > 200 -> "予定名は1～200文字で入力してください。"
    e.end <= e.start || Duration.between(e.start, e.end) > Duration.ofDays(366) -> "終了日時は開始後366日以内で指定してください。"
    e.start.year !in 1..9999 || e.end.year !in 1..9999 -> "日付を確認してください。"
    e.place.length > 500 || e.memo.length > 20000 || e.url.length > 2048 -> "場所は500文字、メモは20,000文字、URLは2,048文字以内で入力してください。"
    e.repeat.mode == "WEEKLY" && e.repeat.weekdays.isEmpty() -> "繰り返す曜日を選んでください。"
    e.repeat.interval !in 1..100 || e.repeat.count?.let { it !in 1..10000 } == true -> "繰り返しの間隔は1～100、回数は1～10,000で指定してください。"
    e.repeat.dates.size > 512 || e.excludedDates.size > 2048 || e.exceptions.size > 2048 -> "繰り返しの日付・個別変更の件数が上限を超えています。"
    else -> null
}
fun trackStatistics(trackId: String, events: List<CalendarEvent>, now: LocalDateTime = nowJapan(), year: Int = now.year): TrackStats {
    val relevant = events.filter { (trackId in it.trackIds || it.exceptions.values.any { v -> v.optJSONObject("replacement")?.strings("trackIds")?.contains(trackId) == true }) && it.deletedAt == null }
    val yearRows = relevant.flatMap { it.occurrences(LocalDate.of(year, 1, 1).minusDays(1), LocalDate.of(year, 12, 31)) }
        .filter { it.endDate.year == year && it.eligible(now) && trackId in it.event.trackIds }.distinctBy { it.key }.sortedWith(compareByDescending<Occurrence> { it.end }.thenByDescending { it.start }.thenBy { it.key })
    val latest = relevant.flatMap { event ->
        if (event.repeat.mode in listOf("NONE", "DATES") || event.repeat.count != null) event.occurrences(event.start.toLocalDate(), now.toLocalDate())
        else {
            val stop = minOf(now.toLocalDate(), event.repeat.until ?: now.toLocalDate())
            val earliest = when (event.repeat.mode) {
                "YEARLY" -> stop.minusYears(event.repeat.interval.toLong() + 1)
                "MONTHLY" -> if (event.repeat.monthly == "NTH") stop.minusYears(400) else stop.minusMonths(event.repeat.interval.toLong() + 1)
                else -> stop.minusYears(2)
            }
            event.occurrences(maxOf(event.start.toLocalDate(), earliest), stop)
        }
    }.filter { it.eligible(now) && trackId in it.event.trackIds }.maxByOrNull { it.end }
    return TrackStats(latest, yearRows.size, yearRows)
}

fun elapsedLabel(from: LocalDate, to: LocalDate = today()): String {
    val total = ChronoUnit.DAYS.between(from, to).coerceAtLeast(0)
    var months = ChronoUnit.MONTHS.between(YearMonth.from(from), YearMonth.from(to))
    if (from.plusMonths(months) > to) months--
    if (months <= 0) return "${total}日"
    val rest = ChronoUnit.DAYS.between(from.plusMonths(months), to)
    return buildString { if (months >= 12) append("${months / 12}年"); if (months % 12 > 0) append("${months % 12}か月"); if (rest > 0) append("${rest}日"); append("（${total}日）") }
}

data class Mutation(val requestId: String = newId(), val kind: String, val id: String, val payload: JSONObject, val expectedVersion: Int) {
    val key get() = "$kind:$id"
    fun json() = JSONObject().put("requestId", requestId).put("kind", kind).put("id", id).put("payload", payload).put("expectedVersion", expectedVersion)
    fun operations(): List<Mutation> = if (kind != "batch") listOf(this) else payload.getJSONArray("operations").let { a -> (0 until a.length()).map { val v = a.getJSONObject(it); Mutation(kind = v.getString("kind"), id = v.getString("id"), payload = v.getJSONObject("payload"), expectedVersion = v.getInt("expectedVersion")) } }
    companion object { fun parse(v: JSONObject) = Mutation(v.getString("requestId"), v.getString("kind"), v.getString("id"), v.getJSONObject("payload"), v.getInt("expectedVersion")) }
}

data class Account(val id: String, val name: String, val identityId: String, val linkId: String, val sessionVersion: String = "", val localOnly: Boolean = false)

fun localAccount(profile: JSONObject) = Account(profile.getString("id"), "この端末", profile.getString("id"), "", "local-v1", localOnly = true)
fun localState(profile: JSONObject, cache: JSONObject?): CalendarState {
    val account = localAccount(profile)
    check(cache == null || cache.optString("accountId") == account.id) { "端末内の予定の保存先を確認できません。" }
    val values = cache?.optJSONArray("entities")
    return CalendarState(account = account, entities = values?.let { a -> (0 until a.length()).map { Entity.parse(a.getJSONObject(it)) } }.orEmpty(), expiresAt = Long.MAX_VALUE)
}
fun expireLocalTrash(entities: List<Entity>, nowMillis: Long): List<Entity> = entities.map { entity ->
    if (entity.kind != "event" || entity.purged) entity else {
        val e = CalendarEvent.parse(entity.body); val cutoff = nowMillis - 30L * 86400000
        if (e.deletedAt != null && e.deletedAt <= cutoff) entity.copy(body = JSONObject().put("id", e.id).put("purged", true), version = entity.version + 1, purged = true)
        else {
            var changed = false
            val exceptions = e.exceptions.mapValues { (_, v) -> if (v.optBoolean("deleted") && v.optionalLong("deletedAt")?.let { it <= cutoff } == true) { changed = true; JSONObject().put("deleted", true) } else v }
            if (changed) entity.copy(body = e.copy(exceptions = exceptions).json(), version = entity.version + 1) else entity
        }
    }
}
data class LoginLink(val id: String, val name: String)
data class Conflict(val pending: Mutation, val server: Entity?, val servers: List<Entity> = listOfNotNull(server))

fun conflictClosure(pending: List<Mutation>, seed: Mutation): List<Mutation> {
    val keys = seed.operations().map { it.key }.toMutableSet()
    var changed: Boolean
    do {
        changed = false
        val namedIds = keys.filter { it.startsWith("track:") || it.startsWith("tag:") }.map { it.substringAfter(':') }
        pending.forEach { mutation -> val operations = mutation.operations(); if (operations.any { it.key in keys || namedIds.any { id -> it.payload.toString().contains("\"$id\"") } }) operations.forEach { if (keys.add(it.key)) changed = true } }
    } while (changed)
    return pending.filter { mutation -> mutation.operations().any { it.key in keys } }
}
fun recoveryConflict(pending: List<Mutation>): Conflict? = if (pending.isEmpty()) null else Conflict(Mutation(kind = "batch", id = newId(), expectedVersion = 0, payload = JSONObject().put("operations", JSONArray(pending.flatMap { it.operations() }.distinctBy { it.key }.map { it.json().apply { remove("requestId") } }))), null)
data class CalendarState(
    val account: Account? = null, val entities: List<Entity> = emptyList(), val pending: List<Mutation> = emptyList(),
    val expiresAt: Long = 0, val lastSync: Long = 0, val offline: Boolean = false, val busy: Boolean = false,
    val error: String? = null, val links: List<LoginLink> = emptyList(), val conflict: Conflict? = null,
    val recoveryRequired: Boolean = false,
) {
    val events get() = entities.filter { it.kind == "event" && !it.purged }.mapNotNull { runCatching { CalendarEvent.parse(it.body).copy(revision = it.version) }.getOrNull() }
    val tracks get() = named("track")
    val tags get() = named("tag")
    val settings get() = entities.firstOrNull { it.kind == "settings" }?.let { CalendarSettings.parse(it.body) } ?: CalendarSettings()
    fun named(kind: String) = entities.filter { it.kind == kind && !it.purged }.mapNotNull { runCatching { NamedItem.parse(it.body).copy(revision = it.version) }.getOrNull() }
}
