package jp.tanaka.troom.calendar

import android.app.Application
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.LocalDateTime

class ReminderRecoveryTest {
    private val now = Instant.parse("2026-11-25T00:00:00Z").epochSecond
    private val event = CalendarEvent(
        title = "通知試験",
        start = LocalDateTime.parse("2026-11-26T12:00"),
        end = LocalDateTime.parse("2026-11-26T13:00"),
        allDay = false,
    )

    private fun reminderRecord() = JSONObject().put("accountId", "account").put("identityId", "identity")
        .put("sessionVersion", "1").put("selectionId", "selection").put("localOnly", false)

    private inner class MemoryStore : CalendarStore {
        private val records = mutableMapOf(
            "mode" to JSONObject().put("type", "CLOUD").put("selectionId", "selection"),
            "auth" to JSONObject().put("accountId", "account").put("identityId", "identity")
                .put("name", "試験").put("linkId", "link").put("sessionVersion", "1")
                .put("cookie", "fixture").put("expiresAt", now + 30 * 86400),
            "cache" to JSONObject().put("accountId", "account").put("identityId", "identity")
                .put("sessionVersion", "1").put("cursor", 1).put("pending", JSONArray())
                .put("entities", JSONArray(listOf(
                    Entity("event", event.id, event.json(), 1).json(),
                    Entity("settings", "preferences", CalendarSettings(reminders = listOf(60)).json(), 1).json(),
                ))),
        )
        var reminderReadFailure: Exception? = null
        var refuseReminderWrites = false
        var reminderWrites = 0
        var reminderRecord: JSONObject?
            get() = records["reminders"]
            set(value) { if (value != null) records["reminders"] = value else records.remove("reminders") }

        override fun read(name: String): JSONObject? {
            if (name == "reminders") reminderReadFailure?.let { throw it }
            return records[name]?.let { JSONObject(it.toString()) }
        }
        override fun write(name: String, json: JSONObject) {
            if (name == "reminders") {
                if (refuseReminderWrites) throw IOException("fixture: write failure")
                reminderWrites++
                reminderReadFailure = null
            }
            records[name] = JSONObject(json.toString())
        }
        override fun delete(name: String) { records.remove(name) }
        override fun renewCookie(expected: String, replacement: String, expiresAt: Long?, serverNow: Long?) = Unit
        override fun anchor(auth: JSONObject, serverNow: Long) = Unit
        override fun trustedNow(auth: JSONObject) = now
    }

    private inner class Transport(var offline: Boolean = false) : CalendarTransport {
        var requests = 0
        override suspend fun request(method: String, path: String, body: JSONObject?, cookie: String?, active: Boolean): CalendarHttpResult {
            requests++
            if (offline) throw IOException("fixture: offline")
            val data = when (path) {
                "/calendar/api/session" -> JSONObject().put("accountId", "account")
                "/calendar/api/sync?cursor=1" -> JSONObject().put("entities", JSONArray()).put("cursor", 1).put("more", false)
                else -> error("Unexpected fixture request")
            }
            return CalendarHttpResult(data, emptyList(), now)
        }
    }

    @Test fun successfulRetryClearsOnlyTheReminderWarningWithoutNetwork() = runBlocking {
        val transport = Transport(offline = true)
        var issue: ReminderIssue? = ReminderIssue.PERMISSION
        val repository = CalendarRepository(Application(), MemoryStore(), transport, schedule = { _, _, _ ->
            issue?.let { throw ReminderRebuildException(it) }
        })
        repository.restore()
        repository.sync()
        val syncError = repository.state.value.error
        assertTrue(repository.state.value.offline)
        assertTrue(syncError?.startsWith("オフライン") == true)
        assertEquals(ReminderIssue.PERMISSION, repository.state.value.reminderIssue)

        issue = null
        repository.retryReminders()
        assertNull(repository.state.value.reminderIssue)
        assertEquals(syncError, repository.state.value.error)
        assertEquals(1, transport.requests)
        assertEquals(event.id, repository.state.value.events.single().id)
    }

    @Test fun completeSyncRebuildsInvalidReminderDataAndOfflineSyncPreservesIt() = runBlocking {
        val badRecord = reminderRecord().put("items", JSONArray().put(JSONObject().put("at", now + 1)))
        for (badRead in listOf(true, false)) {
            val store = MemoryStore().apply {
                reminderRecord = badRecord
                if (badRead) reminderReadFailure = InvalidCalendarRecordException()
            }
            val transport = Transport(offline = true)
            val repository = CalendarRepository(Application(), store, transport)
            repository.restore()
            repository.sync()
            assertEquals(ReminderIssue.READ, repository.state.value.reminderIssue)
            assertEquals(0, store.reminderWrites)
            assertEquals(badRecord.toString(), store.reminderRecord.toString())

            transport.offline = false
            repository.sync()
            assertFalse(repository.state.value.offline)
            assertEquals(1, store.reminderWrites)
            val rebuilt = store.reminderRecord!!.getJSONArray("items")
            assertEquals(1, rebuilt.length())
            assertEquals(event.id, rebuilt.getJSONObject(0).getString("eventId"))
            assertEquals(event.id, repository.state.value.events.single().id)
        }
    }

    @Test fun temporaryReadFailureIsNeverTreatedAsCorruption() = runBlocking {
        val store = MemoryStore().apply {
            reminderRecord = reminderRecord().put("items", JSONArray())
            reminderReadFailure = IOException("fixture: temporarily unavailable")
        }
        val repository = CalendarRepository(Application(), store, Transport())
        repository.restore()
        repository.sync()
        assertFalse(repository.state.value.offline)
        assertEquals(ReminderIssue.READ, repository.state.value.reminderIssue)
        assertEquals(0, store.reminderWrites)
    }

    @Test fun failedWriteKeepsTheLastRecordAndTheSavedEvent() = runBlocking {
        val original = reminderRecord().put("items", JSONArray())
        val store = MemoryStore().apply {
            reminderRecord = original
            refuseReminderWrites = true
        }
        val repository = CalendarRepository(Application(), store, Transport())
        repository.restore()
        repository.sync()
        assertNull(repository.state.value.error)
        assertEquals(ReminderIssue.WRITE, repository.state.value.reminderIssue)
        assertEquals(original.toString(), store.reminderRecord.toString())
        assertEquals(event.id, repository.state.value.events.single().id)
    }
}
