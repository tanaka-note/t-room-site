package jp.tanaka.troom.calendar

import java.time.LocalTime

const val EVENT_TIME_INPUT_EXAMPLE = "9:00-10:00 友達とお出かけ"

data class EventTimeInput(val title: String, val start: LocalTime? = null, val end: LocalTime? = null, val error: String? = null) {
    val hasTime get() = start != null && end != null && error == null
    val endsNextDay get() = hasTime && end!! < start!!
}

private const val TIME_DIGIT = "[0-9０-９]"
private const val TIME_SPACE = "[\\s\u3000]"
private const val TIME_DASH = "[-－−–—〜～~]"
private val eventTimePrefix = Regex("^$TIME_SPACE*$TIME_DIGIT{1,3}[:：]$TIME_DIGIT{1,3}$TIME_SPACE*$TIME_DASH")
private val eventTimeRange = Regex("^$TIME_SPACE*($TIME_DIGIT{1,2})[:：]($TIME_DIGIT{2})$TIME_SPACE*$TIME_DASH$TIME_SPACE*($TIME_DIGIT{1,2})[:：]($TIME_DIGIT{2})(?:$TIME_SPACE+(.*))?$")

fun parseEventTimeInput(input: String): EventTimeInput {
    val plain = EventTimeInput(input.trim())
    if (!eventTimePrefix.containsMatchIn(input)) return plain
    val match = eventTimeRange.matchEntire(input) ?: return plain.copy(error = "「$EVENT_TIME_INPUT_EXAMPLE」のように入力してください。")
    fun number(index: Int) = match.groupValues[index].map { if (it in '０'..'９') ('0'.code + it.code - '０'.code).toChar() else it }.joinToString("").toInt()
    val startHour = number(1); val startMinute = number(2); val endHour = number(3); val endMinute = number(4)
    if (startHour !in 0..23 || endHour !in 0..23 || startMinute !in 0..59 || endMinute !in 0..59) return plain.copy(error = "時刻は0:00〜23:59で入力してください。")
    val title = match.groupValues[5].trim()
    if (title.isEmpty()) return plain.copy(error = "時刻の後に予定名を入力してください。例：$EVENT_TIME_INPUT_EXAMPLE")
    val start = LocalTime.of(startHour, startMinute); val end = LocalTime.of(endHour, endMinute)
    if (start == end) return plain.copy(error = "開始時刻と終了時刻を異なる時刻にしてください。")
    return EventTimeInput(title, start, end)
}
