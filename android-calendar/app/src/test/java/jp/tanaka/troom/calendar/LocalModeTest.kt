package jp.tanaka.troom.calendar

import android.app.Application
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.*

class LocalModeTest {
    private class MemoryStore : CalendarStore {
        val values = mutableMapOf<String, String>(); val reads = mutableListOf<String>()
        var failDataWrites = false
        override fun write(name: String, json: JSONObject) { if (name == "local-cache" && failDataWrites) throw IOException("storage full"); values[name] = json.toString() }
        override fun read(name: String): JSONObject? { reads += name; return values[name]?.let(::JSONObject) }
        override fun delete(name: String) { values.remove(name) }
        override fun renewCookie(expected: String, replacement: String, expiresAt: Long?, serverNow: Long?) = error("No authentication expected")
        override fun anchor(auth: JSONObject, serverNow: Long) = error("No server clock expected")
        override fun trustedNow(auth: JSONObject): Long = error("No login expiry check expected")
    }
    private class NoNetwork : CalendarTransport {
        var calls = 0
        override suspend fun request(method: String, path: String, body: JSONObject?, cookie: String?, active: Boolean): CalendarHttpResult {
            calls++; throw AssertionError("Local mode made a network request")
        }
    }
    private fun repository(store: MemoryStore, network: NoNetwork) = CalendarRepository(Application(), store, network, schedule = { _, _ -> }, clearScheduled = {})
    private fun event(title: String = "食事") = CalendarEvent(title = title, start = LocalDateTime.parse("2026-11-10T18:00"), end = LocalDateTime.parse("2026-11-10T19:00"), allDay = false)

    @Test fun localUsePersistsEventsTrackingAndSettingsWithoutAuthenticationNetworkOrAnOutbox() = runBlocking {
        val store = MemoryStore(); val network = NoNetwork(); val repo = repository(store, network)
        repo.useLocal(); assertTrue(repo.state.value.account!!.localOnly)
        val track = NamedItem(name = "佐藤と遊ぶ")
        assertTrue(repo.save("track", track.id, track.json()))
        val e = event().copy(trackIds = setOf(track.id))
        assertTrue(repo.save("event", e.id, e.json()))
        assertTrue(repo.save("settings", "preferences", CalendarSettings(theme = "mint").json()))
        repo.sync(); assertTrue(repo.state.value.pending.isEmpty()); assertFalse(repo.state.value.offline)
        val restarted = repository(store, network); restarted.restore()
        assertEquals("食事", restarted.state.value.events.single().title); assertEquals(setOf(track.id), restarted.state.value.events.single().trackIds)
        assertEquals("mint", restarted.state.value.settings.theme); assertEquals(Long.MAX_VALUE, restarted.state.value.expiresAt)
        assertEquals(0, network.calls); assertFalse(store.values.containsKey("auth")); assertFalse(store.reads.contains("auth"))
    }
    @Test fun leavingLocalUsePreservesItsDataAndDoesNotResumeOrOverwriteCloudStorage() = runBlocking {
        val store = MemoryStore(); val network = NoNetwork(); val cloud = "{\"accountId\":\"private-cloud\",\"pending\":[{\"opaque\":true}]}"
        store.values["cache"] = cloud; store.values["auth"] = "{\"expiresAt\":1,\"cookie\":\"inactive\"}"
        val repo = repository(store, network); repo.useLocal(); val e = event("この端末の予定"); repo.save("event", e.id, e.json())
        val localId = repo.state.value.account!!.id
        assertTrue(repo.logout()); assertNull(repo.state.value.account)
        val fresh = repository(store, network); fresh.restore(); assertNull(fresh.state.value.account)
        fresh.useLocal(); assertEquals(localId, fresh.state.value.account!!.id); assertEquals("この端末の予定", fresh.state.value.events.single().title)
        assertEquals(cloud, store.values["cache"]); assertEquals("inactive", JSONObject(store.values.getValue("auth")).getString("cookie")); assertEquals(0, network.calls)
        assertFalse(store.reads.contains("auth")); assertFalse(store.reads.contains("cache"))
    }
    @Test fun failedLocalWritesAndStaleEditsKeepTheLastSavedData() = runBlocking {
        val store = MemoryStore(); val network = NoNetwork(); val repo = repository(store, network); repo.useLocal()
        val e = event(); assertTrue(repo.save("event", e.id, e.json()))
        val before = store.values.getValue("local-cache")
        store.failDataWrites = true
        assertFalse(repo.save("event", e.id, e.copy(title = "失敗する変更").json(), 1)); assertEquals(before, store.values["local-cache"])
        assertEquals("食事", repo.state.value.events.single().title)
        store.failDataWrites = false
        assertTrue(repo.save("event", e.id, e.copy(title = "保存済み").json(), 1))
        assertFalse(repo.save("event", e.id, e.copy(title = "古い編集").json(), 1)); assertEquals("保存済み", repo.state.value.events.single().title)
        assertTrue(repo.state.value.pending.isEmpty()); assertEquals(0, network.calls)
    }
    @Test fun localTrashExpiresAndLocalNotificationRulesHaveNoThirtyDayLoginLimit() = runBlocking {
        val store = MemoryStore(); val network = NoNetwork(); val repo = repository(store, network); repo.useLocal()
        val old = event().copy(deletedAt = System.currentTimeMillis() - 31L * 86400000)
        repo.save("event", old.id, old.json()); repo.sync(); assertTrue(repo.state.value.entities.single().purged)
        val scope = selectedReminderScope(store, Instant.parse("2030-01-01T00:00:00Z").epochSecond)!!
        assertTrue(scope.local); assertNull(scope.expiresAt); assertEquals(Long.MAX_VALUE, scope.deadline)
        assertFalse(store.reads.contains("auth")); assertEquals(0, network.calls)
    }
    @Test fun protectedLocalRulesCanRebuildDistantRemindersWithoutPrivateNotes() {
        val e = event().copy(start = LocalDateTime.parse("2028-06-01T18:00"), end = LocalDateTime.parse("2028-06-01T19:00"), memo = "private memo", place = "private place", url = "https://example.test/private")
        val settings = CalendarSettings(reminders = listOf(60))
        val now = Instant.parse("2026-10-30T00:00:00Z")
        val plans = reminderPlans(listOf(e), settings, now.epochSecond)
        assertEquals(1, plans.size); assertEquals("", plans.single().memo); assertEquals("", plans.single().place); assertEquals("", plans.single().url)
        assertTrue(reminderEntries(plans, settings, now, Long.MAX_VALUE).isEmpty())
        assertEquals(1, reminderEntries(plans, settings, Instant.parse("2028-05-31T00:00:00Z"), Long.MAX_VALUE).size)
    }
}
