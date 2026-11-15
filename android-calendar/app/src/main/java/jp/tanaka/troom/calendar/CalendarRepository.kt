package jp.tanaka.troom.calendar

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.activity.ComponentActivity
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

class CalendarApiException(val status: Int, val data: JSONObject) : Exception(data.optString("error", "通信を完了できませんでした。"))
data class CalendarHttpResult(val data: JSONObject, val cookies: List<String>, val now: Long)

interface CalendarTransport {
    suspend fun request(method: String, path: String, body: JSONObject? = null, cookie: String? = null, active: Boolean = false): CalendarHttpResult
}
class CalendarHttp(private val storage: CalendarStore) : CalendarTransport {
    override suspend fun request(method: String, path: String, body: JSONObject?, cookie: String?, active: Boolean): CalendarHttpResult = withContext(Dispatchers.IO) {
        require(path.startsWith("/calendar/api/") || path.startsWith("/security/api/auth/"))
        val connection = URL(BuildConfig.SERVER_BASE_URL + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.instanceFollowRedirects = false; connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "T-lain-Calendar-Android/${BuildConfig.VERSION_NAME}")
            if (cookie != null) connection.setRequestProperty("Cookie", cookie)
            if (active && CalendarActivityWindow.active() && path.startsWith("/calendar/api/")) connection.setRequestProperty("X-Troom-Activity", "foreground")
            if (body != null) {
                connection.doOutput = true; connection.setRequestProperty("Origin", BuildConfig.SERVER_BASE_URL)
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.use { input ->
                val bytes = input.readNBytes(12 * 1024 * 1024 + 1)
                check(bytes.size <= 12 * 1024 * 1024) { "同期データが大きすぎます。" }
                bytes.toString(Charsets.UTF_8)
            }.orEmpty()
            val data = runCatching { JSONObject(raw) }.getOrElse { JSONObject().put("error", "サーバーの応答を確認できませんでした。") }
            if (status !in 200..299) throw CalendarApiException(status, data)
            val cookies = connection.headerFields.filterKeys { it?.equals("Set-Cookie", true) == true }.values.flatten().map { it.substringBefore(';') }
            val now = runCatching { ZonedDateTime.parse(connection.getHeaderField("Date"), DateTimeFormatter.RFC_1123_DATE_TIME).toEpochSecond() }.getOrDefault(System.currentTimeMillis() / 1000)
            if (cookie != null && path.startsWith("/calendar/api/")) cookies.firstOrNull { it.startsWith("troom_calendar_session=") }?.let {
                storage.renewCookie(cookie, it, connection.getHeaderField("X-Troom-Session-Expires")?.toLongOrNull(), now)
            }
            CalendarHttpResult(data, cookies, now)
        } finally { connection.disconnect() }
    }
}

object CalendarActivityWindow {
    @Volatile var foreground = false
    @Volatile var lastInteraction = 0L
    fun touch() { lastInteraction = android.os.SystemClock.elapsedRealtime() }
    fun active() = foreground && android.os.SystemClock.elapsedRealtime() - lastInteraction <= 60000
}

class CalendarRepository(
    private val context: Context,
    val storage: CalendarStore = CalendarStorage(context),
    private val http: CalendarTransport = CalendarHttp(storage),
    private val schedule: (CalendarState, CalendarStore) -> Unit = { state, store -> ReminderScheduler.rebuild(context, state, store) },
    private val clearScheduled: () -> Unit = { ReminderScheduler.clear(context) },
) {
    private val mutex = Mutex()
    private val mutable = MutableStateFlow(CalendarState())
    val state = mutable.asStateFlow()
    private var identityCookie: String? = null
    private var cursor = 0L
    private var generation = 0

    suspend fun restore() = mutex.withLock {
        try {
            val mode = storage.read("mode")?.optString("type")
            if (mode == "NONE") { mutable.value = CalendarState(); return@withLock }
            if (mode == "LOCAL") {
                val profile = storage.read("local-profile") ?: error("端末内の予定の保存先を確認できません。")
                mutable.value = localState(profile, storage.read("local-cache")); refreshLocal(); return@withLock
            }
            val auth = withContext(Dispatchers.IO) { storage.read("auth") } ?: return@withLock
            val expiresAt = auth.getLong("expiresAt")
            if (storage.trustedNow(auth) >= expiresAt) { ReminderScheduler.clear(context); mutable.value = CalendarState(error = "ログイン期限が切れました。パスキーで再認証してください。"); return@withLock }
            val account = Account(auth.getString("accountId"), auth.getString("name"), auth.getString("identityId"), auth.getString("linkId"), auth.getString("sessionVersion"))
            val cache = withContext(Dispatchers.IO) { storage.read("cache") }
            if (cache != null && (cache.optString("accountId") != account.id || cache.optString("identityId") != account.identityId)) error("保存先のアカウントを確認できません。")
            val entities = cache?.optJSONArray("entities")?.let { a -> (0 until a.length()).map { Entity.parse(a.getJSONObject(it)) } }.orEmpty()
            val pending = cache?.optJSONArray("pending")?.let { a -> (0 until a.length()).map { Mutation.parse(a.getJSONObject(it)) } }.orEmpty()
            val matching = cache?.optString("sessionVersion") == account.sessionVersion
            val recovery = !matching && pending.isNotEmpty()
            cursor = if (matching) cache?.optLong("cursor") ?: 0 else 0
            mutable.value = CalendarState(account, if (matching || recovery) entities else emptyList(), pending, expiresAt, if (matching) cache?.optLong("lastSync") ?: 0 else 0, offline = true, recoveryRequired = recovery, conflict = if (recovery) recoveryConflict(pending) else null, error = if (recovery) "復旧によりDBの世代が変わりました。旧データの同期を停止しています。未同期変更を確認してください。" else null)
            if (recovery) ReminderScheduler.clear(context)
        } catch (_: Throwable) { mutable.value = CalendarState(error = "端末の保存データを確認できません。データは保持しています。利用方法を選び直して確認してください。") }
    }

    suspend fun login(activity: ComponentActivity) {
        if (mutable.value.account != null) return
        mutable.value = mutable.value.copy(busy = true, error = null)
        try {
            val options = http.request("POST", "/security/api/auth/options", JSONObject().put("service", "calendar")).data
            val credential = CredentialManager.create(activity).getCredential(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(options.getJSONObject("options").toString())))).credential as? PublicKeyCredential
                ?: error("パスキー認証を完了できませんでした。")
            val verified = http.request("POST", "/security/api/auth/verify", JSONObject().put("service", "calendar").put("challengeId", options.getString("challengeId")).put("response", JSONObject(credential.authenticationResponseJson)))
            identityCookie = verified.cookies.firstOrNull { it.startsWith("troom_security_identity=") } ?: error("認証状態を確認できませんでした。")
            val links = verified.data.getJSONArray("links").let { a -> (0 until a.length()).map { a.getJSONObject(it).let { v -> LoginLink(v.getString("id"), v.optString("displayLabel", v.optString("display_label", "カレンダー"))) } } }
            if (links.isEmpty()) error("Security Centerでカレンダーの利用アカウントを紐づけてください。")
            mutable.value = mutable.value.copy(links = links, busy = false)
            if (links.size == 1) selectAccount(links.single())
        } catch (error: Exception) { mutable.value = mutable.value.copy(busy = false, error = loginError(error)) }
    }
    suspend fun selectAccount(link: LoginLink) = mutex.withLock {
        mutable.value = mutable.value.copy(busy = true, error = null)
        try {
            check(mutable.value.account == null) { "先に現在の利用方法を終了してください。" }
            val handoff = http.request("POST", "/security/api/auth/handoff", JSONObject().put("service", "calendar").put("linkId", link.id), identityCookie ?: error("もう一度パスキー認証してください。"))
            val session = http.request("POST", "/calendar/api/passkey/handoff", JSONObject().put("handoffToken", handoff.data.getString("handoffToken")))
            val cookie = session.cookies.firstOrNull { it.startsWith("troom_calendar_session=") } ?: error("ログインを開始できませんでした。")
            val d = session.data
            val cached = withContext(Dispatchers.IO) { storage.read("cache") }
            if (cached != null && (cached.optString("accountId") != d.getString("accountId") || cached.optString("identityId") != d.getString("identityId")) && (cached.optJSONArray("pending")?.length() ?: 0) > 0) {
                runCatching { http.request("POST", "/calendar/api/logout", JSONObject(), cookie) }
                error("別のアカウントの未同期データを保持しています。元のアカウントで再認証して同期してください。")
            }
            val auth = JSONObject().put("cookie", cookie).put("accountId", d.getString("accountId")).put("name", d.getString("displayName"))
                .put("identityId", d.getString("identityId")).put("linkId", link.id).put("expiresAt", d.getLong("expiresAt")).put("sessionVersion", d.getString("sessionVersion"))
            storage.anchor(auth, session.now)
            withContext(Dispatchers.IO) { synchronized(CalendarSelectionLock) { storage.write("auth", auth); storage.write("mode", JSONObject().put("type", "CLOUD").put("selectionId", newId())); clearScheduled() } }
            cursor = 0
            generation++
            mutable.value = CalendarState(Account(d.getString("accountId"), d.getString("displayName"), d.getString("identityId"), link.id, d.getString("sessionVersion")), expiresAt = d.getLong("expiresAt"))
            if (cached?.optString("accountId") == d.getString("accountId") && cached.optString("identityId") == d.getString("identityId")) {
                val a = cached.optJSONArray("entities") ?: JSONArray(); val p = cached.optJSONArray("pending") ?: JSONArray()
                val pending = (0 until p.length()).map { Mutation.parse(p.getJSONObject(it)) }
                val matching = cached.optString("sessionVersion") == d.getString("sessionVersion")
                val recovery = !matching && pending.isNotEmpty()
                if (matching || recovery) mutable.value = mutable.value.copy(entities = (0 until a.length()).map { Entity.parse(a.getJSONObject(it)) }, pending = pending, lastSync = if (matching) cached.optLong("lastSync") else 0, recoveryRequired = recovery, conflict = if (recovery) recoveryConflict(pending) else null, error = if (recovery) "復旧によりDBの世代が変わりました。旧データの同期を停止しています。未同期変更を確認してください。" else null)
                if (!matching) ReminderScheduler.clear(context)
            }
            identityCookie = null
        } catch (error: Exception) { mutable.value = mutable.value.copy(busy = false, error = loginError(error)) }
    }

    suspend fun sync(active: Boolean = true) = mutex.withLock {
        if (mutable.value.account?.localOnly == true) { refreshLocal(); return@withLock }
        if (mutable.value.recoveryRequired || mutable.value.conflict != null) return@withLock
        val account = mutable.value.account ?: return@withLock
        val auth = withContext(Dispatchers.IO) { storage.read("auth") } ?: return@withLock
        val token = auth.getString("cookie"); val expectedGeneration = generation
        mutable.value = mutable.value.copy(busy = true, error = null)
        try {
            val session = http.request("GET", "/calendar/api/session", cookie = token, active = active)
            if (session.data.getString("accountId") != account.id) error("アカウントが一致しません。")
            while (mutable.value.pending.isNotEmpty()) {
                val operation = mutable.value.pending.first()
                val response = try { http.request("POST", "/calendar/api/mutations", operation.json(), currentCookie(), active) }
                catch (error: CalendarApiException) {
                    if (error.status == 409) {
                        val server = error.data.optJSONObject("current")?.let(Entity::parse)
                        val servers = error.data.optJSONArray("currents")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(Entity::parse) } } ?: listOfNotNull(server)
                        mutable.value = mutable.value.copy(conflict = Conflict(operation, server, servers), busy = false, offline = false, error = "別の端末で更新されています。保存する内容を選んでください。")
                        return@withLock
                    }; throw error
                }
                val committed = response.data.optJSONArray("entities")?.let { a -> (0 until a.length()).map { Entity.parse(a.getJSONObject(it)) } } ?: listOf(Entity.parse(response.data.getJSONObject("entity")))
                val remaining = mutable.value.pending.drop(1)
                val values = mutable.value.entities.associateBy { it.key }.toMutableMap()
                committed.filterNot { c -> remaining.flatMap { it.operations() }.any { it.key == c.key } }.forEach { values[it.key] = it }
                val next = mutable.value.copy(entities = values.values.toList(), pending = remaining)
                persist(next); mutable.value = next
            }
            var more = true; var pages = 0
            while (more && pages++ < 100) {
                val response = http.request("GET", "/calendar/api/sync?cursor=$cursor", cookie = currentCookie(), active = active)
                if (generation != expectedGeneration || mutable.value.account?.id != account.id) return@withLock
                val changes = response.data.getJSONArray("entities").let { a -> (0 until a.length()).map { Entity.parse(a.getJSONObject(it)) } }
                val keyed = mutable.value.entities.associateBy { it.key }.toMutableMap(); changes.forEach { keyed[it.key] = it }
                val nextCursor = response.data.getLong("cursor"); more = response.data.optBoolean("more")
                val updatedAuth = storage.read("auth") ?: error("ログイン状態を確認できません。")
                storage.anchor(updatedAuth, response.now)
                storage.write("auth", updatedAuth)
                val next = mutable.value.copy(entities = keyed.values.toList(), expiresAt = updatedAuth.getLong("expiresAt"), lastSync = response.now * 1000, offline = false, busy = more)
                persist(next, nextCursor); cursor = nextCursor; mutable.value = next
            }
            mutable.value = mutable.value.copy(busy = false, error = null)
            rebuildReminders()
        } catch (error: Exception) {
            if (error is CalendarApiException && error.status in listOf(401, 403)) {
                generation++; ReminderScheduler.clear(context); storage.delete("auth")
                mutable.value = CalendarState(error = "認証または利用権限を確認できません。パスキーで再認証してください。未同期データは保持しています。")
            } else {
                val latestAuth = runCatching { storage.read("auth") }.getOrNull() ?: auth
                val expired = runCatching { storage.trustedNow(latestAuth) >= latestAuth.getLong("expiresAt") }.getOrDefault(true)
                mutable.value = if (expired) CalendarState(error = "オンラインでの再認証が必要です。未同期データは保持しています。")
                else mutable.value.copy(expiresAt = latestAuth.getLong("expiresAt"), busy = false, offline = true, error = if (error is java.io.IOException) "オフラインです。取得済みの予定を利用できます。" else error.message ?: "同期できませんでした。")
                if (expired) ReminderScheduler.clear(context) else rebuildReminders()
            }
        }
    }
    suspend fun save(kind: String, id: String, body: JSONObject, baseVersion: Int? = null): Boolean = mutex.withLock {
        try {
            if (mutable.value.account?.localOnly == true) return@withLock saveLocal(listOf(Triple(kind, id, body)), baseVersion?.let { mapOf("$kind:$id" to it) } ?: emptyMap())
            check(!mutable.value.recoveryRequired) { "先にDB復旧後の未同期変更を確認してください。" }
            val account = mutable.value.account ?: error("ログインしてください。")
            val auth = storage.read("auth") ?: error("オンラインで再認証してください。")
            check(storage.trustedNow(auth) < auth.getLong("expiresAt")) { "ログイン期限が切れました。再認証してください。" }
            check(account.id == auth.getString("accountId"))
            val key = "$kind:$id"; val old = mutable.value.entities.firstOrNull { it.key == key }
            val mutation = Mutation(kind = kind, id = id, payload = body, expectedVersion = baseVersion ?: old?.version ?: 0)
            check(mutation.json().toString().toByteArray(Charsets.UTF_8).size <= 1048576) { "変更が大きすぎます。メモや個別変更を減らしてください。" }
            val entity = Entity(kind, id, body, mutation.expectedVersion + 1)
            val next = mutable.value.copy(entities = mutable.value.entities.filterNot { it.key == key } + entity, pending = mutable.value.pending + mutation, error = null)
            persist(next); mutable.value = next; rebuildReminders(); true
        } catch (error: Exception) { mutable.value = mutable.value.copy(error = error.message ?: "保存できませんでした。"); false }
    }
    suspend fun resolveConflict(useLocal: Boolean) = mutex.withLock {
        val conflict = mutable.value.conflict ?: return@withLock
        try {
            val affected = conflictClosure(mutable.value.pending, conflict.pending)
            val operations = affected.flatMap { it.operations() }.distinctBy { it.key }
            val keys = operations.map { it.key }.toSet()
            val server = operations.chunked(8).flatMap { chunk ->
                http.request("POST", "/calendar/api/entities", JSONObject().put("keys", JSONArray(chunk.map { JSONObject().put("kind", it.kind).put("id", it.id) })), currentCookie(), true).data.getJSONArray("entities").let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(Entity::parse) } }
            }.associateBy { it.key }.toMutableMap()
            val remaining = mutable.value.pending.filterNot { m -> affected.any { it.requestId == m.requestId } }.toMutableList()
            val values = (if (mutable.value.recoveryRequired) emptyList() else mutable.value.entities.filterNot { it.key in keys }).toMutableList()
            if (useLocal) {
                check(server.values.none { it.purged }) { "完全削除された予定は復活できません。必要な内容を控えてから、サーバーの内容を選んでください。" }
                for (mutation in affected) {
                    val rebased = mutation.operations().map { original -> original.copy(requestId = newId(), expectedVersion = server[original.key]?.version ?: 0).also { server[it.key] = Entity(it.kind, it.id, it.payload, it.expectedVersion + 1) } }
                    remaining += group(rebased)
                }
            }
            values += server.values
            val next = mutable.value.copy(entities = values, pending = remaining, conflict = null, error = null, recoveryRequired = false)
            persist(next); mutable.value = next; rebuildReminders()
        } catch (error: Exception) { mutable.value = mutable.value.copy(error = error.message ?: "競合の確認には通信が必要です。") }
    }
    private fun group(operations: List<Mutation>) = if (operations.size == 1) operations.single() else Mutation(kind = "batch", id = newId(), expectedVersion = 0, payload = JSONObject().put("operations", JSONArray(operations.map { it.json().apply { remove("requestId") } })))
    suspend fun saveBatch(changes: List<Pair<String, JSONObject>>, expectedVersions: Map<String, Int> = emptyMap()): Boolean = mutex.withLock {
        try {
            if (mutable.value.account?.localOnly == true) return@withLock saveLocal(changes.map { (kind, body) -> Triple(kind, if (kind == "settings") "preferences" else body.getString("id"), body) }, expectedVersions)
            check(!mutable.value.recoveryRequired) { "先にDB復旧後の未同期変更を確認してください。" }
            val auth = storage.read("auth") ?: error("再認証してください。")
            check(storage.trustedNow(auth) < auth.getLong("expiresAt")) { "ログイン期限が切れました。再認証してください。" }
            check(mutable.value.account?.id == auth.getString("accountId"))
            val operations = changes.map { (kind, body) -> val id = if (kind == "settings") "preferences" else body.getString("id"); Mutation(kind = kind, id = id, payload = body, expectedVersion = expectedVersions["$kind:$id"] ?: mutable.value.entities.firstOrNull { it.key == "$kind:$id" }?.version ?: 0) }
            val keys = operations.map { it.key }.toSet()
            val mutation = group(operations)
            check(mutation.json().toString().toByteArray(Charsets.UTF_8).size <= 1048576) { "変更が大きすぎます。メモや個別変更を減らしてください。" }
            val next = mutable.value.copy(entities = mutable.value.entities.filterNot { it.key in keys } + operations.map { Entity(it.kind, it.id, it.payload, it.expectedVersion + 1) }, pending = mutable.value.pending + mutation, error = null)
            persist(next); mutable.value = next; rebuildReminders(); true
        } catch (error: Exception) { mutable.value = mutable.value.copy(error = error.message ?: "保存できませんでした。"); false }
    }
    suspend fun logout(discardPending: Boolean = false): Boolean = mutex.withLock {
        if (mutable.value.account?.localOnly == true) {
            try {
                synchronized(CalendarSelectionLock) { storage.write("mode", JSONObject().put("type", "NONE")); clearScheduled(); generation++; cursor = 0; identityCookie = null; mutable.value = CalendarState() }
                return@withLock true
            } catch (_: Exception) { mutable.value = mutable.value.copy(error = "選択画面へ戻れませんでした。端末の空き容量を確認してください。予定は保持しています。"); return@withLock false }
        }
        if (mutable.value.pending.isNotEmpty() && !discardPending) { mutable.value = mutable.value.copy(error = "未同期の変更があります。同期するか、破棄を選んでください。"); return@withLock false }
        try {
            storage.read("auth")?.optString("cookie")?.takeIf { it.isNotBlank() }?.let { http.request("POST", "/calendar/api/logout", JSONObject(), it) }
            generation++; identityCookie = null; cursor = 0
            synchronized(CalendarSelectionLock) { storage.write("mode", JSONObject().put("type", "NONE")); clearScheduled(); storage.delete("auth"); storage.delete("cache") }
            mutable.value = CalendarState(); true
        } catch (_: Exception) { mutable.value = mutable.value.copy(error = "オンラインでログアウトを完了してからアカウントを切り替えてください。"); false }
    }
    private suspend fun persist(value: CalendarState, nextCursor: Long = cursor) = withContext(Dispatchers.IO) {
        val json = JSONObject().put("accountId", value.account?.id).put("identityId", value.account?.identityId).put("sessionVersion", value.account?.sessionVersion).put("cursor", nextCursor).put("lastSync", value.lastSync).put("budgetMiB", value.settings.cacheMiB)
            .put("entities", JSONArray(value.entities.map { it.json() })).put("pending", JSONArray(value.pending.map { it.json() }))
        storage.write(if (value.account?.localOnly == true) "local-cache" else "cache", json)
    }
    fun rebuildReminders() {
        runCatching { schedule(mutable.value, storage) }.onFailure { mutable.value = mutable.value.copy(error = "予定は保存済みですが、通知の予約を確認できません。通知設定と端末の空き容量を確認してください。") }
    }
    suspend fun useLocal() = mutex.withLock {
        try {
            check(mutable.value.account == null && !mutable.value.busy) { "現在の操作を終了してから選択してください。" }
            val profile = storage.read("local-profile") ?: JSONObject().put("id", "local-${newId()}").also { storage.write("local-profile", it) }
            val next = localState(profile, storage.read("local-cache"))
            synchronized(CalendarSelectionLock) { storage.write("mode", JSONObject().put("type", "LOCAL").put("selectionId", newId())); clearScheduled(); generation++; cursor = 0; identityCookie = null; mutable.value = next }
            refreshLocal()
        } catch (error: Exception) { mutable.value = mutable.value.copy(busy = false, error = error.message ?: "端末内の予定を開けませんでした。") }
    }
    fun cancelLogin() { if (mutable.value.account == null) { identityCookie = null; mutable.value = CalendarState() } }
    private suspend fun refreshLocal() {
        try {
            val next = mutable.value.copy(entities = expireLocalTrash(mutable.value.entities, System.currentTimeMillis()), pending = emptyList(), busy = false, offline = false, error = null)
            if (next.entities != mutable.value.entities) persist(next)
            mutable.value = next; rebuildReminders()
        } catch (error: Exception) { mutable.value = mutable.value.copy(busy = false, error = error.message ?: "端末内の予定を更新できませんでした。") }
    }
    private suspend fun saveLocal(changes: List<Triple<String, String, JSONObject>>, expected: Map<String, Int>): Boolean {
        check(mutable.value.account?.localOnly == true)
        val values = mutable.value.entities.associateBy { it.key }.toMutableMap()
        for ((kind, id, body) in changes) {
            val key = "$kind:$id"; val old = values[key]
            check(expected[key] == null || expected[key] == (old?.version ?: 0)) { "予定が変更されています。開き直して内容を確認してください。" }
            check(old?.purged != true || body.optBoolean("purged")) { "完全削除した予定は復元できません。" }
            if (kind == "event" && !body.optBoolean("purged")) eventValidation(CalendarEvent.parse(body))?.let { error(it) }
            values[key] = Entity(kind, id, body, (old?.version ?: 0) + 1, body.optBoolean("purged"))
        }
        val next = mutable.value.copy(entities = values.values.toList(), pending = emptyList(), offline = false, error = null)
        persist(next); mutable.value = next; rebuildReminders(); return true
    }
    private fun currentCookie() = storage.read("auth")?.getString("cookie") ?: error("再認証してください。")
    private fun loginError(error: Exception): String = if (error is CalendarApiException && error.status == 404) "カレンダーAPIの接続を確認できません。サービスの公開・利用許可を確認してください。" else error.message ?: "パスキー認証を完了できませんでした。"
}
