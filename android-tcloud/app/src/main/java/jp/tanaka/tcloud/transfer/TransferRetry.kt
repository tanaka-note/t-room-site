package jp.tanaka.tcloud.transfer

import jp.tanaka.tcloud.data.TCloudApiException
import kotlinx.coroutines.delay
import java.io.IOException
import kotlin.random.Random

internal class TransferRetryRequested(cause: Throwable) : Exception(cause)

internal fun isTransientTransferFailure(error: Throwable): Boolean {
    var current: Throwable? = error
    while (current != null) {
        if (current is IOException) return true
        if (current is TCloudApiException &&
            (current.statusCode in setOf(408, 425, 429) || current.statusCode in 500..599)
        ) return true
        current = current.cause
    }
    return false
}

internal suspend fun <T> retryTransientTransfer(
    maxAttempts: Int = 5,
    delayOperation: suspend (Long) -> Unit = { delay(it) },
    jitterMillis: () -> Long = { Random.nextLong(0, 501) },
    operation: suspend () -> T,
): T {
    require(maxAttempts >= 1)
    var lastError: Throwable? = null
    repeat(maxAttempts) { attempt ->
        try {
            return operation()
        } catch (error: Throwable) {
            if (!isTransientTransferFailure(error) || attempt == maxAttempts - 1) throw error
            lastError = error
            delayOperation(transferRetryDelayMillis(error, attempt, jitterMillis()))
        }
    }
    throw checkNotNull(lastError)
}

internal fun transferRetryDelayMillis(error: Throwable, retryIndex: Int, jitterMillis: Long): Long {
    val retryAfter = generateSequence<Throwable>(error) { it.cause }
        .filterIsInstance<TCloudApiException>()
        .mapNotNull(TCloudApiException::retryAfterMillis)
        .firstOrNull()
    if (retryAfter != null) return retryAfter.coerceIn(0, 15 * 60_000L)
    val exponential = 1_000L * (1L shl retryIndex.coerceIn(0, 6))
    return (exponential + jitterMillis.coerceIn(0, 500)).coerceAtMost(60_000L)
}
