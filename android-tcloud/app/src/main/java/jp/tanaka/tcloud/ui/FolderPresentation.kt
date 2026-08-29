package jp.tanaka.tcloud.ui

import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import java.util.Locale

internal data class FolderSortState(
    val mode: String,
    val usesTypeDefaults: Boolean,
)

internal fun folderNavigationDirection(previousDepth: Int, currentDepth: Int): Int = when {
    currentDepth > previousDepth -> 1
    currentDepth < previousDepth -> -1
    else -> 0
}

internal fun defaultFolderSort(folderId: Long?): FolderSortState = if (folderId == null) {
    FolderSortState(mode = "name-asc", usesTypeDefaults = true)
} else {
    FolderSortState(mode = "updated-desc", usesTypeDefaults = true)
}

internal fun nextFolderSort(current: FolderSortState, key: String): FolderSortState {
    require(key in setOf("updated", "name", "size"))
    val currentKey = current.mode.substringBeforeLast('-')
    val nextMode = if (currentKey == key && !current.usesTypeDefaults) {
        if (current.mode.endsWith("-desc")) "$key-asc" else "$key-desc"
    } else {
        if (key == "name") "name-asc" else "$key-desc"
    }
    return FolderSortState(nextMode, usesTypeDefaults = false)
}

internal fun sortFolders(
    folders: List<CloudFolder>,
    query: String,
    sort: FolderSortState,
): List<CloudFolder> {
    val source = folders.filter { it.name.contains(query, ignoreCase = true) }
    if (sort.usesTypeDefaults) return source.sortedBy(::normalizedName)
    return when (sort.mode) {
        "name-desc" -> source.sortedByDescending(::normalizedName)
        "updated-desc" -> source.sortedByDescending { it.updatedAtMillis.coerceAtLeast(it.createdAtMillis) }
        "updated-asc" -> source.sortedBy { it.updatedAtMillis.coerceAtLeast(it.createdAtMillis) }
        "size-desc" -> source.sortedByDescending { it.fileCount }
        "size-asc" -> source.sortedBy { it.fileCount }
        else -> source.sortedBy(::normalizedName)
    }
}

internal fun sortFiles(
    files: List<CloudFile>,
    query: String,
    sort: FolderSortState,
): List<CloudFile> {
    val source = files.filter { it.name.contains(query, ignoreCase = true) }
    return when (sort.mode) {
        "name-desc" -> source.sortedByDescending(::normalizedName)
        "name-asc" -> source.sortedBy(::normalizedName)
        "size-desc" -> source.sortedByDescending { it.sizeBytes }
        "size-asc" -> source.sortedBy { it.sizeBytes }
        "updated-asc" -> source.sortedBy(::updatedTime)
        else -> source.sortedByDescending(::updatedTime)
    }
}

internal fun usesSquareFileCard(file: CloudFile): Boolean =
    file.mediaKind == "image" || file.mediaKind == "video"

internal fun groupFilesForGridDisplay(files: List<CloudFile>, columns: Int = 2): List<List<CloudFile>> {
    require(columns >= 2)
    val rows = mutableListOf<List<CloudFile>>()
    val pendingMedia = mutableListOf<CloudFile>()
    files.forEach { file ->
        if (!usesSquareFileCard(file)) {
            if (pendingMedia.isNotEmpty()) {
                rows += pendingMedia.toList()
                pendingMedia.clear()
            }
            rows += listOf(file)
        } else {
            pendingMedia += file
            if (pendingMedia.size == columns) {
                rows += pendingMedia.toList()
                pendingMedia.clear()
            }
        }
    }
    if (pendingMedia.isNotEmpty()) rows += pendingMedia.toList()
    return rows
}

private fun normalizedName(folder: CloudFolder) = folder.name.lowercase(Locale.JAPANESE)
private fun normalizedName(file: CloudFile) = file.name.lowercase(Locale.JAPANESE)
private fun updatedTime(file: CloudFile): Long = file.updatedAtMillis.coerceAtLeast(file.createdAtMillis)
