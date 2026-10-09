package jp.tanaka.troom.ai.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class HttpResult(val body: JSONObject, val cookies: List<String>)

class AiHttpClient(
    private val baseUrl: String,
    private val onSessionCookie: (String, String) -> Unit = { _, _ -> },
) {
    suspend fun get(path: String, cookie: String? = null): HttpResult = request("GET", path, null, cookie)
    suspend fun post(path: String, body: JSONObject, cookie: String? = null): HttpResult = request("POST", path, body, cookie)

    private suspend fun request(method: String, path: String, body: JSONObject?, cookie: String?): HttpResult = withContext(Dispatchers.IO) {
        val connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 60_000
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "AI-Chat-By-T-ROOM-Android/0.1.0")
            if (cookie != null) setRequestProperty("Cookie", cookie)
            if (path.startsWith("/ai/api/") && AiUserActivity.window.isActive()) setRequestProperty("X-Troom-Activity", "foreground")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Origin", baseUrl)
                outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
        }
        try {
            val status = connection.responseCode
            val raw = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
            if (status !in 200..299) throw ApiException(status, json.optString("error", "処理を完了できませんでした。"))
            val cookies = connection.headerFields.entries
                .filter { it.key?.equals("Set-Cookie", ignoreCase = true) == true }
                .flatMap { it.value ?: emptyList() }
                .map { it.substringBefore(';') }
            if (cookie != null && path.startsWith("/ai/api/")) {
                cookies.firstOrNull { it.startsWith("troom_ai_session=") }?.let { onSessionCookie(cookie, it) }
            }
            HttpResult(json, cookies)
        } finally {
            connection.disconnect()
        }
    }
}

class ApiException(val status: Int, override val message: String) : Exception(message)
