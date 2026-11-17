package jp.tanaka.troom.calendar

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.YearMonth

class CalendarUiStateTest {
    @Test fun monthPagesKeepYearBoundariesAndSelectedDatesInTheDisplayedMonth() {
        for (month in listOf(YearMonth.of(1, 1), YearMonth.of(2026, 12), YearMonth.of(2027, 1), YearMonth.of(9999, 12))) {
            assertEquals(month, calendarMonthAt(calendarMonthPage(month)))
            assertEquals(month, YearMonth.from(calendarSelectedDate(month, 31)))
        }
        assertEquals(0, calendarMonthPage(YearMonth.of(1, 1)))
        assertEquals(CALENDAR_MONTH_COUNT - 1, calendarMonthPage(YearMonth.of(9999, 12)))
        assertEquals(LocalDate.of(2026, 2, 28), calendarSelectedDate(YearMonth.of(2026, 2), 31))
        assertEquals(LocalDate.of(2028, 2, 29), calendarSelectedDate(YearMonth.of(2028, 2), 31))
        assertEquals(LocalDate.of(2026, 3, 31), calendarSelectedDate(YearMonth.of(2026, 3), 31))
    }

    @Test fun existingPreferencesDefaultToSystemAndNewAppearanceSurvivesRoundTrip() {
        assertEquals("system", CalendarSettings.parse(JSONObject().put("theme", "mint")).appearance)
        assertEquals("system", CalendarSettings.parse(JSONObject().put("appearance", "unknown")).appearance)
        for (theme in calendarPalettes.map { it.id }) for (appearance in listOf("system", "light", "dark")) {
            val settings = CalendarSettings(theme = theme, appearance = appearance, durationMinutes = 90, reminders = listOf(60), eventReminders = mapOf("appointment" to listOf(10)))
            assertEquals(settings, CalendarSettings.parse(settings.json()))
        }
    }

    @Test fun everyPaletteKeepsPrimaryActionsAndTextReadableInBothAppearances() {
        fun contrast(a: Color, b: Color): Float {
            val x = a.luminance(); val y = b.luminance()
            return (maxOf(x, y) + .05f) / (minOf(x, y) + .05f)
        }
        for (palette in calendarPalettes) for (dark in listOf(false, true)) {
            val c = calendarColorScheme(palette.id, dark)
            for ((foreground, background) in listOf(c.onPrimary to c.primary, c.onSurface to c.surface, c.onPrimaryContainer to c.primaryContainer, c.onSurfaceVariant to c.surfaceVariant)) {
                assertTrue("${palette.id}/$dark must retain 4.5:1 text contrast", contrast(foreground, background) >= 4.5f)
            }
        }
    }
}
