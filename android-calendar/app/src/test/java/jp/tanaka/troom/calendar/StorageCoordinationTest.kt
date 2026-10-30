package jp.tanaka.troom.calendar

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class StorageCoordinationTest {
    @Test fun separateWrappersShareTheSameRecordLockWhileReminderReadsRemainIndependent() {
        val pool = Executors.newFixedThreadPool(3)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val readerStarted = CountDownLatch(1)
        var record = "old"
        try {
            val writer = pool.submit { CalendarRecordLocks.withRecord("fixture/cache.bin") {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); record = "complete"
            } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val reader = pool.submit<String> { readerStarted.countDown(); CalendarRecordLocks.withRecord("fixture/cache.bin") { record } }
            assertTrue(readerStarted.await(5, TimeUnit.SECONDS))
            val reminder = pool.submit<String> { CalendarRecordLocks.withRecord("fixture/reminders.bin") { "available" } }
            assertEquals("available", reminder.get(5, TimeUnit.SECONDS))
            assertFalse("a second wrapper must not read an unfinished record", reader.isDone)
            release.countDown(); writer.get(5, TimeUnit.SECONDS)
            assertEquals("complete", reader.get(5, TimeUnit.SECONDS))
        } finally { release.countDown(); pool.shutdownNow() }
    }
    @Test fun renewalCanReadAndWriteItsRecordUnderTheSameLock() {
        val pool = Executors.newSingleThreadExecutor()
        try {
            val renewal = pool.submit<String> { CalendarRecordLocks.withRecord("fixture/auth.bin") {
                CalendarRecordLocks.withRecord("fixture/auth.bin") { "renewed" }
            } }
            assertEquals("renewed", renewal.get(5, TimeUnit.SECONDS))
        } finally { pool.shutdownNow() }
    }
}
