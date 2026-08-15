package jp.tanaka.tcloud.transfer

import jp.tanaka.tcloud.data.TCloudApiException
import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TransferRetryTest {
    @Test
    fun `temporary network and HTTP failures are retryable`() {
        assertTrue(isTransientTransferFailure(IOException("connection reset")))
        listOf(408, 425, 429, 500, 502, 503, 599).forEach { status ->
            assertTrue("HTTP $status", isTransientTransferFailure(TCloudApiException(status, "temporary")))
        }
    }

    @Test
    fun `permanent client failures are not retried`() {
        listOf(400, 401, 403, 404, 409, 415, 422).forEach { status ->
            assertFalse("HTTP $status", isTransientTransferFailure(TCloudApiException(status, "permanent")))
        }
    }

    @Test
    fun `transient operation retries five attempts with exponential jittered delays`() = runBlocking {
        var attempts = 0
        val delays = mutableListOf<Long>()

        val result = retryTransientTransfer(
            delayOperation = delays::add,
            jitterMillis = { 250 },
        ) {
            attempts += 1
            if (attempts < 5) throw IOException("offline")
            "ok"
        }

        assertEquals("ok", result)
        assertEquals(5, attempts)
        assertEquals(listOf(1_250L, 2_250L, 4_250L, 8_250L), delays)
    }

    @Test
    fun `retry after overrides exponential delay and is bounded`() {
        assertEquals(
            42_000L,
            transferRetryDelayMillis(TCloudApiException(429, "later", 42_000), 0, 500),
        )
        assertEquals(
            15 * 60_000L,
            transferRetryDelayMillis(TCloudApiException(429, "later", Long.MAX_VALUE), 0, 0),
        )
    }

    @Test
    fun `permanent failure stops after the first attempt`() = runBlocking {
        var attempts = 0
        runCatching {
            retryTransientTransfer(delayOperation = {}, jitterMillis = { 0 }) {
                attempts += 1
                throw TCloudApiException(403, "forbidden")
            }
        }
        assertEquals(1, attempts)
    }
}
