package jp.tanaka.tcloud.backup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraBackupSourceFoldersTest {
    @Test
    fun `all-folder mode accepts existing and newly created device folders`() {
        assertTrue(cameraSourceFolderSelected(true, emptySet(), "camera"))
        assertTrue(cameraSourceFolderSelected(true, setOf("screenshots"), "new-folder"))
    }

    @Test
    fun `individual mode accepts only explicitly selected device folders`() {
        val selected = setOf("camera", "screenshots")

        assertTrue(cameraSourceFolderSelected(false, selected, "camera"))
        assertTrue(cameraSourceFolderSelected(false, selected, "screenshots"))
        assertFalse(cameraSourceFolderSelected(false, selected, "downloads"))
    }

    @Test
    fun `individual folder filter has one placeholder per stable bucket id`() {
        val filter = cameraSourceFolderFilter(false, setOf("22", "11"))

        assertTrue(filter.sql.orEmpty().contains("bucket_id IN (?,?)"))
        assertTrue(filter.arguments == listOf("11", "22"))
    }

    @Test
    fun `all-folder filter does not restrict MediaStore query`() {
        val filter = cameraSourceFolderFilter(true, setOf("11"))

        assertTrue(filter.sql == null)
        assertTrue(filter.arguments.isEmpty())
    }
}
