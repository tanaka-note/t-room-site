package jp.tanaka.troom.calendar

import android.Manifest
import android.app.*
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import kotlinx.coroutines.*
import org.json.JSONArray
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

object ReminderScheduler {
    private const val CHANNEL = "calendar-events"
    private fun alarm(context: Context) = context.getSystemService(AlarmManager::class.java)
    private fun pending(context: Context) = PendingIntent.getBroadcast(context, 1, Intent(context, ReminderReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun permitted(context: Context) = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED && alarm(context).canScheduleExactAlarms()
    fun rebuild(context: Context, state: CalendarState, storage: CalendarStorage) {
        val account = state.account ?: return clear(context)
        val auth = storage.read("auth") ?: return clear(context)
        val now = storage.trustedNow(auth)
        val existing = storage.read("reminders")
        val knownIds = state.entities.filter { it.kind == "event" }.map { it.id }.toSet()
        val kept = if (existing?.optString("accountId") == account.id && existing.optString("identityId") == account.identityId) {
            entries(existing).filter { it.eventId !in knownIds && it.at > now && it.at < state.expiresAt }
        } else emptyList()
        val values = (reminderEntries(state.events, state.settings, Instant.ofEpochSecond(now), state.expiresAt) + kept).distinctBy { it.key }.sortedBy { it.at }
        check(values.size <= 20000) { "通知の件数が多すぎます。通知設定を減らしてください。" }
        storage.write("reminders", JSONObject().put("accountId", account.id).put("identityId", account.identityId).put("sessionVersion", account.sessionVersion).put("expiresAt", state.expiresAt).put("items", JSONArray(values.map { it.json() })))
        schedule(context, values, now, state.expiresAt)
    }
    private fun entries(v: JSONObject): List<ReminderEntry> = v.optJSONArray("items")?.let { a -> (0 until a.length()).map { ReminderEntry.parse(a.getJSONObject(it)) } }.orEmpty()
    private fun schedule(context: Context, values: List<ReminderEntry>, now: Long, expiresAt: Long) {
        alarm(context).cancel(pending(context))
        // A final cleanup also removes already displayed private notifications.
        if (values.isEmpty() || !permitted(context)) {
            if (expiresAt > now) alarm(context).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt * 1000, pending(context))
            if (values.isEmpty()) return
        }
        check(permitted(context)) { "通知とアラームの許可が必要です。" }
        alarm(context).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, maxOf(values.first().at, now + 1) * 1000, pending(context))
    }
    fun resume(context: Context) {
        val storage = CalendarStorage(context)
        val auth = storage.read("auth") ?: return clear(context)
        val reminders = storage.read("reminders") ?: return
        val now = storage.trustedNow(auth)
        if (reminders.optString("accountId") != auth.optString("accountId") || reminders.optString("identityId") != auth.optString("identityId") || reminders.optString("sessionVersion") != auth.optString("sessionVersion") || now >= auth.optLong("expiresAt")) return clear(context)
        val all = entries(reminders)
        val due = all.filter { it.at <= now && now - it.at <= 3600 }
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { alarm(context).cancel(pending(context)); return }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "予定の通知", NotificationManager.IMPORTANCE_HIGH))
        for (item in due) {
            val intent = Intent(context, MainActivity::class.java).setData(android.net.Uri.parse("calendar://reminder/${android.net.Uri.encode(auth.getString("accountId"))}/${android.net.Uri.encode(item.key)}")).putExtra("eventId", item.eventId).putExtra("accountId", auth.getString("accountId"))
            val open = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.notify(item.key, 0, Notification.Builder(context, CHANNEL).setSmallIcon(jp.tanaka.troom.calendar.R.drawable.ic_calendar).setContentTitle(item.title).setContentText("予定の時刻が近づいています").setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).build())
        }
        val remaining = all.filter { it.at > now && it.at < auth.getLong("expiresAt") }
        storage.write("reminders", reminders.put("items", JSONArray(remaining.map { it.json() })))
        schedule(context, remaining, now, auth.getLong("expiresAt"))
    }
    fun clear(context: Context) {
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
