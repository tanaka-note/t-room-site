package jp.tanaka.tcloud.transfer

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

internal const val MAX_CONCURRENT_FILE_TRANSFERS = 4

/** One process-wide gate shared by upload, camera backup, and download batches. */
internal object TCloudTransferConcurrency {
    val permits = Semaphore(MAX_CONCURRENT_FILE_TRANSFERS)
}

internal suspend fun <T, R> runFileTransfers(
    items: List<T>,
    permits: Semaphore = TCloudTransferConcurrency.permits,
    transfer: suspend (T) -> R,
): List<R> = supervisorScope {
    items.map { item ->
        async {
            permits.withPermit { transfer(item) }
        }
    }.awaitAll()
}

internal enum class TransferItemOutcome {
    FINISHED,
    RETRY,
}
