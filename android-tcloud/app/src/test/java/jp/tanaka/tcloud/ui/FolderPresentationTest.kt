package jp.tanaka.tcloud.ui

import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderPresentationTest {
    @Test
    fun `root defaults to folder name ascending`() {
        val sorted = sortFolders(
            listOf(folder(2, "Zoo"), folder(1, "Alpha")),
            query = "",
            sort = defaultFolderSort(null),
        )
        assertEquals(listOf("Alpha", "Zoo"), sorted.map { it.name })
    }

    @Test
    fun `opened folder defaults to files updated descending and folders name ascending`() {
        val sort = defaultFolderSort(10)
        val folders = sortFolders(listOf(folder(2, "Zoo"), folder(1, "Alpha")), "", sort)
        val files = sortFiles(listOf(file(1, "old", 100), file(2, "new", 300)), "", sort)
        assertEquals(listOf("Alpha", "Zoo"), folders.map { it.name })
        assertEquals(listOf("new", "old"), files.map { it.name })
    }

    @Test
    fun `sort button starts with web defaults then reverses on second press`() {
        val first = nextFolderSort(defaultFolderSort(10), "size")
        val second = nextFolderSort(first, "size")
        assertEquals("size-desc", first.mode)
        assertEquals("size-asc", second.mode)
    }

    @Test
    fun `dummy mixed files can be searched and sorted by size`() {
        val files = listOf(file(1, "sample-small.mp4", 100), file(2, "sample-large.mp4", 200))
        val result = sortFiles(files, "sample", FolderSortState("size-desc", false))
        assertEquals(listOf("sample-large.mp4", "sample-small.mp4"), result.map { it.name })
    }

    private fun folder(id: Long, name: String) = CloudFolder(
        id, null, name, 1, "", "", "", "", "", "", "", "", false, true, 0, 0,
    )

    private fun file(id: Long, name: String, updated: Long) = CloudFile(
        id = id,
        folderId = 10,
        name = name,
        mimeType = "video/mp4",
        mediaKind = "video",
        sizeBytes = updated,
        cryptoVersion = 1,
        encryptedMetadata = "",
        metadataIv = "",
        wrappedFileKey = "",
        fileKeyIv = "",
        chunkSizeBytes = 8,
        chunkCount = 1,
        hasThumbnail = true,
        metadataDecrypted = true,
        updatedAtMillis = updated,
    )
}
