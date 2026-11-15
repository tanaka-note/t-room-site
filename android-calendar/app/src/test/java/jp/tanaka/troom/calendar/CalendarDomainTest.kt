package jp.tanaka.troom.calendar

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.time.*

class CalendarDomainTest {
    private fun event(date: String, title: String = "食事", track: String = "friend", rule: RepeatRule = RepeatRule()) = CalendarEvent(title = title, start = LocalDate.parse(date).atTime(18, 0), end = LocalDate.parse(date).atTime(19, 0), allDay = false, trackIds = setOf(track), repeat = rule)
    @Test fun differentTitlesAndMultipleTracksUseMembershipRatherThanTitle() {
        val now = LocalDateTime.parse("2026-10-29T20:00")
        val rows = listOf(event("2026-05-03", "佐藤と遊ぶ"), event("2026-08-16", "佐藤と公園"), event("2026-09-14", "食事").copy(trackIds = setOf("friend", "dinner")), event("2026-10-30"), event("2026-10-20").copy(cancelled = true), event("2026-10-21").copy(deletedAt = 1), event("2026-10-22").copy(trackIds = emptySet()))
        val stats = trackStatistics("friend", rows, now)
        assertEquals(3, stats.yearCount); assertEquals(LocalDate.parse("2026-09-14"), stats.last!!.endDate)
        assertEquals(1, trackStatistics("dinner", rows, now).yearCount)
    }
    @Test fun monthlyMissingDaysClampWithoutDrifting() {
        for (year in listOf(2026, 2028)) for (day in listOf(30, 31)) {
            val value = event("$year-01-$day", rule = RepeatRule("MONTHLY"))
            val occurrences = value.occurrences(LocalDate.of(year, 1, 1), LocalDate.of(year, 3, 31))
            assertEquals(listOf(day, if (Year.isLeap(year.toLong())) 29 else 28, day), occurrences.map { it.start.dayOfMonth })
        }
    }
    @Test fun allDayAndCrossMidnightUseEndDateAndEndTime() {
        val allDay = CalendarEvent(title = "終日", start = LocalDate.parse("2026-10-29").atStartOfDay(), end = LocalDate.parse("2026-10-30").atStartOfDay())
        val row = allDay.occurrences(today().withYear(2026).withMonth(10).withDayOfMonth(29), LocalDate.parse("2026-10-29")).single()
        assertFalse(row.eligible(LocalDateTime.parse("2026-10-29T23:59"))); assertTrue(row.eligible(LocalDateTime.parse("2026-10-30T00:00")))
        assertEquals(LocalDate.parse("2026-10-29"), row.endDate)
        val crossing = event("2026-12-31").copy(start = LocalDateTime.parse("2026-12-31T23:00"), end = LocalDateTime.parse("2027-01-01T01:00"))
        assertEquals(1, trackStatistics("friend", listOf(crossing), LocalDateTime.parse("2027-01-02T00:00"), 2027).yearCount)
        assertEquals(0, trackStatistics("friend", listOf(crossing), LocalDateTime.parse("2027-01-02T00:00"), 2026).yearCount)
    }
    @Test fun biweeklyAndExclusionsAndCounts() {
        val value = event("2026-10-04", rule = RepeatRule("WEEKLY", 2, setOf(7, 2), count = 4)).copy(excludedDates = setOf(LocalDate.parse("2026-10-06")))
        assertEquals(listOf("2026-10-04", "2026-10-18", "2026-10-20"), value.occurrences(LocalDate.parse("2026-10-01"), LocalDate.parse("2026-11-30")).map { it.start.toLocalDate().toString() })
    }
    @Test fun finiteOldSeriesStillHasLastRecord() {
        val value = event("2000-01-01", rule = RepeatRule("DAILY", count = 3))
        val stats = trackStatistics("friend", listOf(value), LocalDateTime.parse("2026-10-29T20:00"))
        assertEquals(LocalDate.parse("2000-01-03"), stats.last!!.endDate); assertEquals(0, stats.yearCount)
    }
    @Test fun movedOccurrenceIsFoundInItsNewMonth() {
        val value = event("2026-01-01", rule = RepeatRule("MONTHLY"))
        val replacement = value.copy(start = LocalDateTime.parse("2026-03-04T18:00"), end = LocalDateTime.parse("2026-03-04T19:00"), repeat = RepeatRule())
        val moved = value.copy(exceptions = mapOf("2026-02-01" to JSONObject().put("replacement", replacement.json())))
        assertEquals(1, moved.occurrences(LocalDate.parse("2026-03-04"), LocalDate.parse("2026-03-04")).size)
    }
    @Test fun elapsedUsesCalendarMonthsAndTotalDays() {
        assertEquals("1か月15日（45日）", elapsedLabel(LocalDate.parse("2026-09-14"), LocalDate.parse("2026-10-29")))
        assertEquals("1か月（28日）", elapsedLabel(LocalDate.parse("2026-01-31"), LocalDate.parse("2026-02-28")))
    }
    @Test fun remindersUseMidnightDeduplicateAndRespectSessionExpiry() {
        val e = CalendarEvent(title = "終日", start = LocalDateTime.parse("2026-10-30T00:00"), end = LocalDateTime.parse("2026-10-31T00:00"))
        val now = LocalDateTime.parse("2026-10-29T12:00").atZone(JAPAN).toInstant()
        val reminders = reminderEntries(listOf(e), CalendarSettings(reminders = listOf(0, 60, 60)), now, now.epochSecond + 30 * 86400)
        assertEquals(2, reminders.size)
        assertEquals(LocalDateTime.parse("2026-10-29T23:00").atZone(JAPAN).toEpochSecond(), reminders.first().at)
        assertTrue(reminderEntries(listOf(e), CalendarSettings(reminders = listOf(0)), now, now.epochSecond + 3600).isEmpty())
    }
    @Test fun dataRoundTripPreservesTitleIndependentTrackingAndRules() {
        val source = event("2026-10-29", rule = RepeatRule("MONTHLY", monthly = "LAST"))
        assertEquals(source, CalendarEvent.parse(source.json()))
    }
    @Test fun singleOccurrenceTrashRestoresItsPreviousEditAndPermanentDeleteRemovesContents() {
        val source = event("2026-10-01", rule = RepeatRule("MONTHLY"))
        val edited = source.copy(title = "予定を変更", repeat = RepeatRule())
        val series = source.copy(exceptions = mapOf("2026-11-01" to JSONObject().put("replacement", edited.json()).put("cancelled", true).put("deleted", true).put("deletedAt", 123L)))
        val entry = trashEntries(listOf(series)).single()
        assertEquals("予定を変更", entry.title)
        val restored = entry.restore().exceptions.getValue("2026-11-01")
        assertEquals("予定を変更", restored.getJSONObject("replacement").getString("title")); assertTrue(restored.getBoolean("cancelled")); assertFalse(restored.has("deletedAt"))
        assertEquals("{\"deleted\":true}", entry.purge().getJSONObject("exceptions").getJSONObject("2026-11-01").toString())
    }
    @Test fun conflictClosureKeepsUnrelatedEditsAndIncludesDependentPendingEvents() {
        val item = NamedItem(name = "friend")
        val first = Mutation(kind = "track", id = item.id, payload = item.json(), expectedVersion = 0)
        val dependent = event("2026-10-29", track = item.id)
        val second = Mutation(kind = "event", id = dependent.id, payload = dependent.json(), expectedVersion = 0)
        val independent = event("2026-10-28", track = "other")
        val third = Mutation(kind = "event", id = independent.id, payload = independent.json(), expectedVersion = 0)
        assertEquals(listOf(first.requestId, second.requestId), conflictClosure(listOf(first, second, third), first).map { it.requestId })
    }
    @Test fun recoveryReviewIncludesEveryUnsentOperationAndSnapshotsKeepTheirOpeningVersion() {
        val old = event("2026-10-01")
        val state = CalendarState(entities = listOf(Entity("event", old.id, old.json(), version = 5)))
        val editing = state.events.single(); assertEquals(5, editing.copy(title = "編集中").revision)
        val newer = state.copy(entities = listOf(Entity("event", old.id, old.json(), version = 6)))
        assertEquals(6, newer.events.single().revision); assertEquals(5, editing.revision)
        val first = Mutation(kind = "event", id = old.id, payload = old.json(), expectedVersion = 5)
        val other = event("2026-10-02"); val second = Mutation(kind = "event", id = other.id, payload = other.json(), expectedVersion = 1)
        assertEquals(2, conflictClosure(listOf(first, second), recoveryConflict(listOf(first, second))!!.pending).size)
    }
    @Test fun sameDayTwoAppointmentsCountTwiceAndOfflineInputRejectsInvalidEndAndWeekdays() {
        val one = event("2026-10-29"); val two = event("2026-10-29")
        assertEquals(2, trackStatistics("friend", listOf(one, two), LocalDateTime.parse("2026-10-29T21:00")).yearCount)
        assertNotNull(eventValidation(one.copy(end = one.start))); assertNotNull(eventValidation(one.copy(repeat = RepeatRule("WEEKLY"))))
        assertNull(eventValidation(one))
    }
}
