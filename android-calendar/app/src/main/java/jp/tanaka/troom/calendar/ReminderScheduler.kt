package jp.tanaka.troom.calendar

import android.Manifest
import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.*

data class ReminderEntry(val key: String, val eventId: String, val title: String, val at: Long) {
    fun json() = JSONObject().put("key", key).put("eventId", eventId).put("title", title).put("at", at)
    companion object { fun parse(v: JSONObject) = ReminderEntry(v.getString("key"), v.getString("eventId"), v.getString("title"), v.getLong("at")) }
}
fun reminderEntries(events: List<CalendarEvent>, settings: CalendarSettings, now: Instant, expiresAt: Long): List<ReminderEntry> {
    val from = now.atZone(JAPAN).toLocalDate().minusDays(1)
    val maxOffset = (settings.reminders + settings.eventReminders.values.flatten()).maxOrNull() ?: 0
    val through = from.plusDays(32 + maxOffset / 1440L)
    return events.filter { it.deletedAt == null && !it.cancelled }.flatMap { event ->
        event.occurrences(from, through).filter { !it.cancelled && !it.deleted }.flatMap { occurrence ->
            settings.minutesFor(event.id, occurrence.anchor).map { offset ->
                ReminderEntry("${occurrence.key}:$offset", event.id, occurrence.event.title, occurrence.start.atZone(JAPAN).toEpochSecond() - offset * 60L)
            }
        }
    }.filter { it.at > now.epochSecond && it.at < expiresAt }.distinctBy { it.key }.sortedBy { it.at }
}

data class ReminderScope(val accountId: String, val identityId: String, val version: String, val selectionId: String, val local: Boolean, val now: Long, val expiresAt: Long?) {
    val deadline get() = expiresAt ?: Long.MAX_VALUE
    fun matches(v: JSONObject) = v.optString("accountId") == accountId && v.optString("identityId") == identityId && v.optString("sessionVersion") == version && v.optString("selectionId") == selectionId && v.optBoolean("localOnly") == local
}
fun selectedReminderScope(storage: CalendarStore, wallNow: Long = System.currentTimeMillis() / 1000): ReminderScope? {
    val mode = storage.read("mode"); val type = mode?.optString("type")
    if (type == "NONE") return null
    if (type == "LOCAL") {
        val profile = storage.read("local-profile") ?: return null
        val account = localAccount(profile)
        return ReminderScope(account.id, account.identityId, account.sessionVersion, mode.optString("selectionId"), true, wallNow, null)
    }
    val auth = storage.read("auth") ?: return null
    val now = storage.trustedNow(auth); val expires = auth.getLong("expiresAt")
    if (now >= expires) return null
    return ReminderScope(auth.getString("accountId"), auth.getString("identityId"), auth.getString("sessionVersion"), mode?.optString("selectionId") ?: "", false, now, expires)
}
fun reminderPlans(events: List<CalendarEvent>, settings: CalendarSettings, now: Long): List<CalendarEvent> {
    val overrides = settings.eventReminders.keys.map { it.substringBefore('@') }.toSet()
    fun minimal(e: CalendarEvent): CalendarEvent = e.copy(trackIds = emptySet(), tagIds = emptySet(), place = "", memo = "", url = "", exceptions = e.exceptions.mapValues { (_, v) -> JSONObject(v.toString()).apply { v.optJSONObject("replacement")?.let { put("replacement", minimal(CalendarEvent.parse(it)).json()) } } })
    return events.filter { e -> e.deletedAt == null && !e.cancelled && (settings.reminders.isNotEmpty() || e.id in overrides) && (e.repeat.mode != "NONE" || e.start.atZone(JAPAN).toEpochSecond() > now) }.map(::minimal)
}

enum class ReminderPermission { NOTIFICATIONS, EXACT_ALARMS }

enum class ReminderIssue(val message: String) {
    PERMISSION("通知を予約するには、Androidの通知と「アラームとリマインダー」を許可してください。"),
    READ("端末の通知用データを読み込めませんでした。"),
    WRITE("端末に通知用データを保存できませんでした。"),
    LIMIT("通知の件数が上限を超えています。通知設定を減らしてください。"),
    ALARM("Androidに通知を予約できませんでした。"),
    REBUILD("通知の予約を更新できませんでした。"),
}

internal class ReminderRebuildException(val issue: ReminderIssue, cause: Exception? = null) :
    Exception(issue.message, cause)

object ReminderScheduler {
    private const val CHANNEL = "calendar-events"
    private fun alarm(context: Context) = context.getSystemService(AlarmManager::class.java)
    private fun pending(context: Context) = PendingIntent.getBroadcast(context, 1, Intent(context, ReminderReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun missingPermission(context: Context): ReminderPermission? = when {
        !context.getSystemService(NotificationManager::class.java).areNotificationsEnabled() -> ReminderPermission.NOTIFICATIONS
        !alarm(context).canScheduleExactAlarms() -> ReminderPermission.EXACT_ALARMS
        else -> null
    }

    fun permitted(context: Context) = missingPermission(context) == null
    fun rebuild(context: Context, state: CalendarState, storage: CalendarStore, allowSnapshotRepair: Boolean = false) =
        synchronized(CalendarSelectionLock) { rebuildLocked(context, state, storage, allowSnapshotRepair) }

    private fun rebuildLocked(context: Context, state: CalendarState, storage: CalendarStore, allowSnapshotRepair: Boolean) {
        val account = state.account ?: return clear(context)
        val scope = selectedReminderScope(storage) ?: return clear(context)
        if (scope.accountId != account.id || scope.identityId != account.identityId || scope.local != account.localOnly || scope.version != account.sessionVersion) return
        val now = scope.now
        val canRepair = scope.local || allowSnapshotRepair
        val existing = try {
            storage.read("reminders")
        } catch (error: InvalidCalendarRecordException) {
            if (!canRepair) throw ReminderRebuildException(ReminderIssue.READ, error)
            null
        } catch (error: Exception) {
            throw ReminderRebuildException(ReminderIssue.READ, error)
        }
        val knownIds = state.entities.filter { it.kind == "event" }.map { it.id }.toSet()
        val kept = if (!scope.local && existing != null && scope.matches(existing)) {
            try {
                entries(existing).filter { it.eventId !in knownIds && it.at > now && it.at < scope.deadline }
            } catch (error: JSONException) {
                if (!canRepair) throw ReminderRebuildException(ReminderIssue.READ, error)
                emptyList()
            }
        } else emptyList()
        val values = (reminderEntries(state.events, state.settings, Instant.ofEpochSecond(now), scope.deadline) + kept).distinctBy { it.key }.sortedBy { it.at }
        if (values.size > 20000) throw ReminderRebuildException(ReminderIssue.LIMIT)
        val snapshot = JSONObject().put("accountId", account.id).put("identityId", account.identityId).put("sessionVersion", account.sessionVersion).put("selectionId", scope.selectionId).put("localOnly", scope.local).put("expiresAt", scope.expiresAt ?: JSONObject.NULL).put("items", JSONArray(values.map { it.json() }))
        var plans = emptyList<CalendarEvent>()
        if (scope.local) {
            plans = reminderPlans(state.events, state.settings, now)
            val ids = plans.map { it.id }.toSet()
            val notices = CalendarSettings(reminders = state.settings.reminders, eventReminders = state.settings.eventReminders.filterKeys { it.substringBefore('@') in ids })
            snapshot.put("plans", JSONArray(plans.map { it.json() })).put("notices", notices.json())
        }
        if (existing?.toString() != snapshot.toString()) {
            try {
                storage.write("reminders", snapshot)
            } catch (error: Exception) {
                throw ReminderRebuildException(ReminderIssue.WRITE, error)
            }
        }
        schedule(context, values, now, scope.expiresAt, plans.isNotEmpty())
    }
    private fun entries(v: JSONObject): List<ReminderEntry> = v.optJSONArray("items")?.let { a -> (0 until a.length()).map { ReminderEntry.parse(a.getJSONObject(it)) } }.orEmpty()
    private fun schedule(context: Context, values: List<ReminderEntry>, now: Long, expiresAt: Long?, maintainLocal: Boolean = false) {
        val allowed = try {
            val manager = alarm(context)
            val operation = pending(context)
            val maintenance = if (maintainLocal) now + 86400 else expiresAt
            val due = values.firstOrNull()?.at
            val hasPermissions = permitted(context)
            val next = listOfNotNull(if (hasPermissions) due else null, maintenance).filter { it > now }.minOrNull()
            // Android replaces a reservation with the same PendingIntent. Cancel only when no alarm is needed.
            when {
                next == null -> manager.cancel(operation)
                hasPermissions && next == due -> manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next * 1000, operation)
                else -> manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next * 1000, operation)
            }
            hasPermissions
        } catch (error: Exception) {
            throw ReminderRebuildException(ReminderIssue.ALARM, error)
        }
        if (!allowed && (values.isNotEmpty() || maintainLocal)) throw ReminderRebuildException(ReminderIssue.PERMISSION)
    }
    fun resume(context: Context) = synchronized(CalendarSelectionLock) { resumeLocked(context) }
    private fun resumeLocked(context: Context) {
        val storage = CalendarStorage(context)
        val scope = selectedReminderScope(storage) ?: return clear(context)
        val reminders = storage.read("reminders") ?: return
        val now = scope.now
        if (!scope.matches(reminders)) return clear(context)
        val all = entries(reminders)
        val due = all.filter { it.at <= now && now - it.at <= 3600 }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "予定の通知", NotificationManager.IMPORTANCE_HIGH))
        for (item in if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) due else emptyList()) {
            val intent = Intent(context, MainActivity::class.java).setData(android.net.Uri.parse("calendar://reminder/${android.net.Uri.encode(scope.accountId)}/${android.net.Uri.encode(item.key)}")).putExtra("eventId", item.eventId).putExtra("accountId", scope.accountId)
            val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.notify(item.key, 0, Notification.Builder(context, CHANNEL).setSmallIcon(jp.tanaka.troom.calendar.R.drawable.ic_calendar).setContentTitle(item.title).setContentText("予定の時刻が近づいています").setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).build())
        }
        val plans = reminders.optJSONArray("plans")?.let { a -> (0 until a.length()).map { CalendarEvent.parse(a.getJSONObject(it)) } }.orEmpty()
        val remaining = if (scope.local) reminderEntries(plans, CalendarSettings.parse(reminders.getJSONObject("notices")), Instant.ofEpochSecond(now), Long.MAX_VALUE) else all.filter { it.at > now && it.at < scope.deadline }
        storage.write("reminders", reminders.put("items", JSONArray(remaining.map { it.json() })))
        schedule(context, remaining, now, scope.expiresAt, scope.local && plans.isNotEmpty())
    }
    fun clear(context: Context) = synchronized(CalendarSelectionLock) { clearLocked(context) }
    private fun clearLocked(context: Context) {
        alarm(context).cancel(pending(context))
        context.getSystemService(NotificationManager::class.java).cancelAll()
        CalendarStorage(context).delete("reminders")
    }
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch { try { ReminderScheduler.resume(context.applicationContext) } catch (_: Exception) { /* Keep protected records for the next rebuild. */ } finally { pending.finish() } }
    }
}
class RebuildRemindersReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch { try { ReminderScheduler.resume(context.applicationContext) } catch (_: Exception) { /* Do not erase reminder records on a transient failure. */ } finally { pending.finish() } }
    }
}
