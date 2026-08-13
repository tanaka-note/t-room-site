package jp.tanaka.tcloud.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TCloudApiRequestPolicyTest {
    @Test
    fun `delete requests always identify the trusted JSON origin`() {
        val headers = tCloudApiHeaders("DELETE")

        assertEquals("https://tanaka-note.com", headers["Origin"])
        assertEquals("application/json; charset=utf-8", headers["Content-Type"])
    }

    @Test
    fun `all mutation methods use the same request protection`() {
        listOf("POST", "PUT", "PATCH", "DELETE").forEach { method ->
            val headers = tCloudApiHeaders(method)
            assertTrue(method, headers.containsKey("Origin"))
            assertTrue(method, headers.containsKey("Content-Type"))
        }
    }

    @Test
    fun `read-only requests do not send mutation headers`() {
        listOf("GET", "HEAD").forEach { method ->
            val headers = tCloudApiHeaders(method)
            assertFalse(method, headers.containsKey("Origin"))
            assertFalse(method, headers.containsKey("Content-Type"))
        }
    }
}
