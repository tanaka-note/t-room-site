package jp.tanaka.troom.calendar

import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

class EventTimeInputTest {
    @Test fun exampleSeparatesTimesFromTheAppointmentTitle() {
        val value = parseEventTimeInput("9:00-10:00 友達とお出かけ")
        assertEquals("友達とお出かけ", value.title)
        assertEquals(LocalTime.of(9, 0), value.start); assertEquals(LocalTime.of(10, 0), value.end)
        assertTrue(value.hasTime); assertFalse(value.endsNextDay); assertNull(value.error)
    }
    @Test fun japaneseKeyboardDigitsPunctuationAndSpacesAreAccepted() {
        for (input in listOf("９：００－１０：３０　友達とお出かけ", "9:00〜10:30 友達とお出かけ", " 9:00 - 10:30   友達とお出かけ ", "9:00–10:30 友達とお出かけ")) {
            val value = parseEventTimeInput(input)
            assertEquals("友達とお出かけ", value.title); assertEquals(LocalTime.of(9, 0), value.start); assertEquals(LocalTime.of(10, 30), value.end)
            assertNull(value.error)
        }
    }
    @Test fun overnightRangeEndsOnTheFollowingDayAcrossYearBoundaries() {
        val value = parseEventTimeInput("23:30-1:00 夜の予定")
        assertTrue(value.endsNextDay)
        val day = LocalDate.of(2026, 12, 31)
        assertEquals("2027-01-01T01:00", day.plusDays(if (value.endsNextDay) 1 else 0).atTime(value.end).toString())
    }
    @Test fun invalidOrIncompleteRangesCannotSilentlySaveAsAllDayTitles() {
        for (input in listOf("24:00-10:00 予定", "9:60-10:00 予定", "9:00-25:00 予定", "9:00-9:00 予定", "9:00-10:00", "9:0-10:00 予定", "9:00-", "9:00-10:00予定")) {
            val value = parseEventTimeInput(input)
            assertNotNull(input, value.error); assertFalse(input, value.hasTime)
        }
    }
    @Test fun ordinaryTitlesAndTimesInsideTitlesArePreserved() {
        for (title in listOf("友達とお出かけ", "10:00開演の映画", "2026-11-18 友達とお出かけ", "会議 9:00-10:00")) {
            assertEquals(EventTimeInput(title), parseEventTimeInput(title))
        }
    }
    @Test fun onlyTheLeadingRangeIsExtractedAndTheRestOfTheTitleStaysIntact() {
        val value = parseEventTimeInput("9:00-10:00 11:00の会議の準備")
        assertEquals("11:00の会議の準備", value.title); assertTrue(value.hasTime)
    }
}
