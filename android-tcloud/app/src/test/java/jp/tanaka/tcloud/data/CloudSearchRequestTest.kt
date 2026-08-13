package jp.tanaka.tcloud.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudSearchRequestTest {
    @Test
    fun `initial request searches folders and files recursively below the current folder`() {
        val parameters = cloudSearchQueryParameters(42L, "旅行", "all", 0, 0, 500)

        assertEquals("42", parameters["folderId"])
        assertEquals("旅行", parameters["q"])
        assertEquals("1", parameters["recursive"])
        assertEquals("250", parameters["pageSize"])
        assertFalse(parameters.containsKey("kind"))
        assertFalse(parameters.containsKey("filesOnly"))
        assertFalse(parameters.containsKey("foldersOnly"))
    }

    @Test
    fun `when folder results are exhausted only files continue`() {
        val parameters = cloudSearchQueryParameters(null, "音楽", "audio", null, 250, 250)

        assertEquals("audio", parameters["kind"])
        assertEquals("1", parameters["filesOnly"])
        assertFalse(parameters.containsKey("foldersOnly"))
        assertFalse(parameters.containsKey("folderId"))
    }

    @Test
    fun `when file results are exhausted only folders continue`() {
        val parameters = cloudSearchQueryParameters(7L, "資料", "all", 250, null, 100)

        assertEquals("1", parameters["foldersOnly"])
        assertFalse(parameters.containsKey("filesOnly"))
        assertTrue(parameters.containsKey("folderOffset"))
        assertFalse(parameters.containsKey("fileOffset"))
    }
}
