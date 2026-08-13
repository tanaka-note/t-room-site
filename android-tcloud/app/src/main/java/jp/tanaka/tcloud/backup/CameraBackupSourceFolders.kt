package jp.tanaka.tcloud.backup

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class CameraBackupSourceFolder(
    val id: String,
    val name: String,
    val imageCount: Int,
    val videoCount: Int,
) {
    val itemCount: Int get() = imageCount + videoCount
}

internal fun cameraSourceFolderSelected(
    allSourceFolders: Boolean,
    selectedFolderIds: Set<String>,
    folderId: String,
): Boolean = allSourceFolders || folderId in selectedFolderIds

internal data class CameraSourceFolderFilter(
    val sql: String?,
    val arguments: List<String>,
)

internal fun cameraSourceFolderFilter(
    allSourceFolders: Boolean,
    selectedFolderIds: Set<String>,
): CameraSourceFolderFilter = if (allSourceFolders) {
    CameraSourceFolderFilter(null, emptyList())
} else {
    val ids = selectedFolderIds.filter(String::isNotBlank).sorted()
    CameraSourceFolderFilter(
        sql = if (ids.isEmpty()) null else
            "${MediaStore.Files.FileColumns.BUCKET_ID} IN (${ids.joinToString(",") { "?" }})",
        arguments = ids,
    )
}

suspend fun queryCameraBackupSourceFolders(context: Context): List<CameraBackupSourceFolder> =
    withContext(Dispatchers.IO) {
        val canReadImages = canReadMedia(context, image = true)
        val canReadVideos = canReadMedia(context, image = false)
        if (!canReadImages && !canReadVideos) return@withContext emptyList()

        data class MutableFolder(
            var name: String,
            var imageCount: Int = 0,
            var videoCount: Int = 0,
        )

        val folders = linkedMapOf<String, MutableFolder>()
        val collection = MediaStore.Files.getContentUri("external")
        val projection = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.Files.FileColumns.BUCKET_ID,
            MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME,
        )
        val types = buildList {
            if (canReadImages) add(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE)
            if (canReadVideos) add(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)
        }
        val placeholders = types.joinToString(",") { "?" }
        context.contentResolver.query(
            collection,
            projection,
            "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($placeholders)",
            types.map(Int::toString).toTypedArray(),
            "${MediaStore.Files.FileColumns.DATE_ADDED} DESC",
        )?.use { cursor ->
            val typeIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
            val bucketIdIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_ID)
            val bucketNameIndex = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME)
            while (cursor.moveToNext()) {
                val bucketId = cursor.getLong(bucketIdIndex).toString()
                val bucketName = cursor.getString(bucketNameIndex).orEmpty().ifBlank { "その他" }
                val folder = folders.getOrPut(bucketId) { MutableFolder(bucketName) }
                if (cursor.getInt(typeIndex) == MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE) {
                    folder.imageCount += 1
                } else {
                    folder.videoCount += 1
                }
            }
        }
        folders.map { (id, folder) ->
            CameraBackupSourceFolder(id, folder.name, folder.imageCount, folder.videoCount)
        }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }

private fun canReadMedia(context: Context, image: Boolean): Boolean = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> {
        val permission = if (image) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_MEDIA_VIDEO
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
                ) == PackageManager.PERMISSION_GRANTED)
    }
    else -> ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) ==
        PackageManager.PERMISSION_GRANTED
}
