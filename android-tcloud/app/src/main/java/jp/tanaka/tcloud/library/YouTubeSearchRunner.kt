package jp.tanaka.tcloud.library

import jp.tanaka.tcloud.data.TCloudApiException
import jp.tanaka.tcloud.data.YouTubeVideoMetadata
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal class YouTubeSearchRunner(
    private val scope: CoroutineScope,
    private val search: suspend (String, Int) -> List<YouTubeVideoMetadata>,
    private val onCleared: (String) -> Unit,
    private val onStarted: (String) -> Unit,
    private val onSuccess: (String, List<PlayableMediaItem>) -> Unit,
    private val onFailure: (String, String, Boolean) -> Unit,
    private val debounceMs: Long = 400L,
) {
    private var job: Job? = null
    private var generation = 0L

    fun submit(rawQuery: String) {
        val query = rawQuery.trim()
        val requestGeneration = ++generation
        job?.cancel()
        if (query.length < 2) {
            onCleared(query)
            return
        }

        onStarted(query)
        job = scope.launch {
            delay(debounceMs)
            try {
                val items = search(query, MAX_RESULTS).map { it.toPlayableMediaItem() }
                if (requestGeneration == generation) onSuccess(query, items)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (requestGeneration == generation) {
                    onFailure(query, youtubeSearchUserMessage(error), error is TCloudApiException && error.statusCode == 503)
                }
            }
        }
    }

    fun cancel() {
        generation += 1
        job?.cancel()
        job = null
        onCleared("")
    }

    private companion object {
        const val MAX_RESULTS = 10
    }
}

internal fun youtubeSearchUserMessage(error: Throwable): String = when {
    error is TCloudApiException && error.statusCode == 401 ->
        "ログインの有効期限が切れました。T-Cloudへ再度ログインしてください。"
    error is TCloudApiException && error.statusCode == 403 ->
        "YouTube検索を利用する権限を確認できません。T-Cloudへ再度ログインしてください。"
    error is TCloudApiException && error.statusCode == 503 ->
        "YouTube検索のAPI設定が完了していません。"
    error is TCloudApiException && error.statusCode == 502 ->
        "YouTube側の問題で検索できませんでした。時間をおいてもう一度お試しください。"
    error is IOException ->
        "ネットワークに接続できません。通信状態を確認して、もう一度お試しください。"
    else -> "YouTube検索を完了できませんでした。もう一度お試しください。"
}
