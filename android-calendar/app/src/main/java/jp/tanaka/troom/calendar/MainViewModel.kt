package jp.tanaka.troom.calendar

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import org.json.JSONObject
import java.time.*

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CalendarApplication
    val repository = app.repository
    val state = repository.state
    val holidays: Map<LocalDate, String> = application.assets.open("holidays.json").bufferedReader().use { reader ->
        val values = JSONObject(reader.readText()).getJSONObject("holidays")
        values.keys().asSequence().associate { LocalDate.parse(it) to values.getString(it) }
    }
    init { viewModelScope.launch { app.ready.await(); repository.sync() } }
    fun sync(active: Boolean = true) = viewModelScope.launch { if (active) CalendarActivityWindow.touch(); app.ready.await(); repository.sync(active) }
    fun login(activity: ComponentActivity) = viewModelScope.launch { repository.login(activity); if (state.value.account != null) repository.sync() }
    fun select(link: LoginLink) = viewModelScope.launch { repository.selectAccount(link); if (state.value.account != null) repository.sync() }
    fun useLocal() = viewModelScope.launch { app.ready.await(); repository.useLocal() }
    fun cancelLogin() = repository.cancelLogin()
    fun settings(value: CalendarSettings) = viewModelScope.launch { CalendarActivityWindow.touch(); if (repository.save("settings", "preferences", value.json())) repository.sync() }
    fun named(kind: String, value: NamedItem) = viewModelScope.launch { CalendarActivityWindow.touch(); if (repository.save(kind, value.id, value.json(), value.revision)) repository.sync() }
    fun logout(discard: Boolean = false) = viewModelScope.launch { if (!discard && state.value.pending.isNotEmpty()) repository.sync(); repository.logout(discard) }
    fun resolve(local: Boolean) = viewModelScope.launch { repository.resolveConflict(local); repository.sync() }
    suspend fun saveEvent(event: CalendarEvent): Boolean {
        CalendarActivityWindow.touch()
        val saved = repository.save("event", event.id, event.json(), event.revision)
        if (saved) viewModelScope.launch { repository.sync() }
        return saved
    }
    suspend fun findOrCreate(kind: String, names: List<String>): Set<String> {
        check(names.map { it.trim() }.filter { it.isNotBlank() }.distinct().size <= 32 && names.all { it.trim().length <= 100 }) { "追跡・タグは各32個まで、名前は100文字以内で入力してください。" }
        val result = mutableSetOf<String>()
        for (name in names.map { it.trim() }.filter { it.isNotBlank() }.distinct()) {
            val old = state.value.named(kind).firstOrNull { it.name == name && it.mergedInto == null }
            if (old != null) { result += old.id; continue }
            val item = NamedItem(name = name)
            check(repository.save(kind, item.id, item.json())) { state.value.error ?: "項目を保存できませんでした。" }
            result += item.id
        }
        return result
    }
    suspend fun merge(kind: String, source: NamedItem, target: NamedItem): Boolean {
        CalendarActivityWindow.touch()
        if (source.id == target.id) return false
        val result = repository.save(kind, source.id, source.copy(mergedInto = target.id, archived = true).json(), source.revision)
        if (result) viewModelScope.launch { repository.sync() }
        return result
    }
    fun canonical(id: String, kind: String): String {
        var current = id; val seen = mutableSetOf<String>()
        while (seen.add(current)) {
            current = state.value.named(kind).firstOrNull { it.id == current }?.mergedInto ?: return current
        }
        return id
    }
    fun events(): List<CalendarEvent> {
        fun normalize(e: CalendarEvent): CalendarEvent = e.copy(trackIds = e.trackIds.map { canonical(it, "track") }.toSet(), tagIds = e.tagIds.map { canonical(it, "tag") }.toSet(), exceptions = e.exceptions.mapValues { (_, v) -> JSONObject(v.toString()).apply { v.optJSONObject("replacement")?.let { put("replacement", normalize(CalendarEvent.parse(it)).json()) } } })
        return state.value.events.map(::normalize)
    }
}
