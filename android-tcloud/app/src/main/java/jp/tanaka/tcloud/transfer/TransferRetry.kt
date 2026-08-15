package jp.tanaka.tcloud.transfer

import jp.tanaka.tcloud.data.TCloudApiException
import kotlinx.coroutines.delay
import java.io.IOException

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
    maxAttempts: Int = 3,
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
            delay(1_000L shl attempt)
        }
    }
    throw checkNotNull(lastError)
}
