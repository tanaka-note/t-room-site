package jp.tanaka.troom.calendar

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.io.IOException
import java.time.Duration
import java.time.Instant
import java.time.LocalDate

class CalendarHolidaysTest {
    private val bundled = File("src/main/assets/holidays.json").bufferedReader().use {
        val values = JSONObject(it.readText()).getJSONObject("holidays")
        val dates = values.keys().asSequence().associate { day -> LocalDate.parse(day) to values.getString(day) }
        HolidaySnapshot(dates, Instant.parse("2026-10-28T15:00:00Z"))
    }
    private val sample2028 = bundled.dates.filterKeys { it.year == 2027 }.mapKeys { (date, _) -> date.withYear(2028) }
    private val bundledAndNew = bundled.dates + sample2028

    @Test
    fun publicHolidaysRefreshWithoutAnAccountAndLoadOfflineAfterRestart() = runBlocking {
        val cache = TestCache()
        val changedDate = LocalDate.of(2027, 3, 22)
        val corrected = bundledAndNew + (changedDate to "振替休日")
        var online = false
        var time = Instant.parse("2027-02-03T00:00:00Z")
        var requests = 0
        fun repo() = CalendarHolidays(bundled, cache, { online }, {
            requests++
            csv(corrected)
        }, { time })

        val app = repo()
        app.refreshIfDue()
        assertEquals(0, requests)
        assertEquals(2027, app.state.value.throughYear)
        online = true
        app.refreshIfDue()
        assertEquals(2028, app.state.value.throughYear)
        assertEquals("振替休日", app.state.value.dates[changedDate])
        assertEquals("元日", app.state.value.dates[LocalDate.of(2028, 1, 1)])
        assertEquals(time, cache.saved?.checkedAt)

        val restarted = repo()
        online = false
        restarted.refreshIfDue()
        assertEquals(corrected, restarted.state.value.dates)
        online = true
        time = time.plus(Duration.ofHours(23))
        restarted.refreshIfDue()
        assertEquals(1, requests)
        time = time.plus(Duration.ofHours(1))
        restarted.refreshIfDue()
        assertEquals(2, requests)
    }

    @Test
    fun incompleteAndRegressedSourcesKeepLastVerifiedData() = runBlocking {
        val cache = TestCache()
        var time = Instant.parse("2027-02-03T00:00:00Z")
        var response = csv(bundledAndNew.filterKeys { it.year < 2028 || it.monthValue <= 3 })
        var requests = 0
        val app = CalendarHolidays(bundled, cache, { true }, {
            requests++
            response
        }, { time })
        app.refreshIfDue()
        assertNull(cache.saved)
        assertEquals(2027, app.state.value.throughYear)
        app.refreshIfDue()
        assertEquals(1, requests)

        time = time.plus(Duration.ofHours(1))
        response = csv(bundledAndNew)
        app.refreshIfDue()
        assertEquals(2028, cache.saved?.throughYear)
        val verified = cache.saved

        time = time.plus(Duration.ofDays(1))
        response = csv(bundled.dates)
        app.refreshIfDue()
        assertEquals(verified, cache.saved)
        assertEquals(verified, app.state.value)

        time = time.plus(Duration.ofHours(1))
        response = "<html>maintenance</html>".toByteArray()
        app.refreshIfDue()
        assertEquals(verified, app.state.value)
    }

    @Test
    fun cacheReadAndWriteFailureLeavesBundledHolidaysUsable() = runBlocking {
        val cache = TestCache(fail = true)
        val app = CalendarHolidays(bundled, cache, { true }, { csv(bundledAndNew) })
        app.refreshIfDue()
        assertEquals(bundled.dates, app.state.value.dates)
        assertNull(app.state.value.checkedAt)
    }

    private class TestCache(private val fail: Boolean = false) : HolidayCache {
        var saved: HolidaySnapshot? = null
            private set

        override fun read(): HolidaySnapshot? {
            if (fail) throw IOException("Unreadable fixture")
            return saved
        }

        override fun write(snapshot: HolidaySnapshot) {
            if (fail) throw IOException("Full fixture")
            saved = snapshot
        }
    }

    private fun csv(dates: Map<LocalDate, String>) = buildString {
        append("国民の祝日・休日月日,国民の祝日・休日名称\r\n")
        dates.toSortedMap().forEach { (day, name) ->
            append("${day.year}/${day.monthValue}/${day.dayOfMonth},${name}\r\n")
        }
    }.toByteArray(charset("Shift_JIS"))
}
