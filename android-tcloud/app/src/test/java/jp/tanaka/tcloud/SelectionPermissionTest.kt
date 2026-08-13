package jp.tanaka.tcloud

import jp.tanaka.tcloud.data.FolderPage
import jp.tanaka.tcloud.data.Session
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SelectionPermissionTest {
    private fun page(canTrashContents: Boolean) = FolderPage(
        currentFolder = null,
        breadcrumbs = emptyList(),
        folders = emptyList(),
        files = emptyList(),
        canTrashContents = canTrashContents,
    )

    @Test
    fun `admin can delete a selection at cloud root`() {
        assertTrue(canDeleteSelection(Session(authenticated = true, role = "admin"), page(false)))
    }

    @Test
    fun `subadmin requires an unlocked deletable folder`() {
        val subadmin = Session(authenticated = true, role = "subadmin")
        assertFalse(canDeleteSelection(subadmin, page(false)))
        assertTrue(canDeleteSelection(subadmin, page(true)))
    }
}
