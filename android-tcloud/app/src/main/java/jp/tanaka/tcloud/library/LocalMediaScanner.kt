package jp.tanaka.tcloud.library

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class LocalMediaScanResult(
    val items: List<PlayableMediaItem>,
    val mediaStoreVersion: String,
    val audioPermission: Boolean,
    val videoPermission: Boolean,
)

class LocalMediaScanner(private val context: Context) {
    fun currentVersion(): String = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        runCatching { MediaStore.getVersion(context) }.getOrDefault("")
    } else {
        "legacy"
    }

    suspend fun scan(): LocalMediaScanResult = withContext(Dispatchers.IO) {
        val audio = canReadAudio(context)
        val video = canReadVideo(context)
        val items = buildList {
            if (audio) addAll(queryAudio())
            if (video) addAll(queryVideo())
        }
        LocalMediaScanResult(
            items = items,
            mediaStoreVersion = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) currentVersion() else {
                items.maxOfOrNull(PlayableMediaItem::updatedAt)?.toString().orEmpty()
            },
            audioPermission = audio,
            videoPermission = video,
        )
    }

    private fun queryAudio(): List<PlayableMediaItem> {
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val projection = buildList {
            add(MediaStore.Audio.Media._ID)
            add(MediaStore.Audio.Media.DISPLAY_NAME)
            add(MediaStore.Audio.Media.TITLE)
            add(MediaStore.Audio.Media.ARTIST)
            add(MediaStore.Audio.Media.ALBUM)
            add(MediaStore.Audio.Media.ALBUM_ID)
            add(MediaStore.Audio.Media.TRACK)
            add(MediaStore.Audio.Media.DURATION)
            add(MediaStore.Audio.Media.DATE_MODIFIED)
            add(MediaStore.Audio.Media.MIME_TYPE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(MediaStore.Audio.Media.RELATIVE_PATH)
        }.toTypedArray()
        return context.contentResolver.query(
            collection,
            projection,
            "${MediaStore.Audio.Media.IS_MUSIC} != 0",
            null,
            "${MediaStore.Audio.Media.DATE_MODIFIED} DESC, ${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
            val titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
            val artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
            val albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
            val albumIdColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID)
            val trackColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK)
            val durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
            val modifiedColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
            val pathColumn = cursor.getColumnIndex(MediaStore.Audio.Media.RELATIVE_PATH)
            buildList {
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idColumn)
                    val uri = ContentUris.withAppendedId(collection, id).toString()
                    val albumId = cursor.getLong(albumIdColumn)
                    add(
                        PlayableMediaItem(
                            stableId = "local:audio:$id",
                            source = MediaSourceType.LOCAL,
                            mediaType = LibraryMediaType.AUDIO,
                            title = cursor.getString(titleColumn).orEmpty().ifBlank {
                                cursor.getString(nameColumn).orEmpty().substringBeforeLast('.')
                            },
                            fileName = cursor.getString(nameColumn).orEmpty(),
                            artist = cursor.getString(artistColumn).orEmpty().normalizedUnknown("不明なアーティスト"),
                            album = cursor.getString(albumColumn).orEmpty().normalizedUnknown("不明なアルバム"),
                            trackNumber = (cursor.getInt(trackColumn) % 1000).coerceAtLeast(0),
                            durationMs = cursor.getLong(durationColumn).coerceAtLeast(0),
                            artworkUri = if (albumId > 0) "content://media/external/audio/albumart/$albumId" else "",
                            location = if (pathColumn >= 0) cursor.getString(pathColumn).orEmpty() else "端末",
                            playbackUri = uri,
                            updatedAt = cursor.getLong(modifiedColumn).coerceAtLeast(0) * 1_000L,
                            addedAt = cursor.getLong(modifiedColumn).coerceAtLeast(0) * 1_000L,
                        ),
                    )
                }
            }
        }.orEmpty()
    }

    private fun queryVideo(): List<PlayableMediaItem> {
        val collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val projection = buildList {
            add(MediaStore.Video.Media._ID)
            add(MediaStore.Video.Media.DISPLAY_NAME)
            add(MediaStore.Video.Media.TITLE)
            add(MediaStore.Video.Media.DURATION)
            add(MediaStore.Video.Media.DATE_MODIFIED)
            add(MediaStore.Video.Media.MIME_TYPE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(MediaStore.Video.Media.RELATIVE_PATH)
        }.toTypedArray()
        return context.contentResolver.query(
            collection,
            projection,
            null,
            null,
            "${MediaStore.Video.Media.DATE_MODIFIED} DESC, ${MediaStore.Video.Media.TITLE} COLLATE NOCASE ASC",
        )?.use { cursor ->
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME)
            val titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.TITLE)
            val durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION)
            val modifiedColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DATE_MODIFIED)
            val pathColumn = cursor.getColumnIndex(MediaStore.Video.Media.RELATIVE_PATH)
            buildList {
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(idColumn)
                    val uri = ContentUris.withAppendedId(collection, id).toString()
                    add(
                        PlayableMediaItem(
                            stableId = "local:video:$id",
                            source = MediaSourceType.LOCAL,
                            mediaType = LibraryMediaType.VIDEO,
                            title = cursor.getString(titleColumn).orEmpty().ifBlank {
                                cursor.getString(nameColumn).orEmpty().substringBeforeLast('.')
                            },
                            fileName = cursor.getString(nameColumn).orEmpty(),
                            durationMs = cursor.getLong(durationColumn).coerceAtLeast(0),
                            artworkUri = uri,
                            location = if (pathColumn >= 0) cursor.getString(pathColumn).orEmpty() else "端末",
                            playbackUri = uri,
                            updatedAt = cursor.getLong(modifiedColumn).coerceAtLeast(0) * 1_000L,
                            addedAt = cursor.getLong(modifiedColumn).coerceAtLeast(0) * 1_000L,
                        ),
                    )
                }
            }
        }.orEmpty()
    }
}

internal fun requiredLocalMediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
        Manifest.permission.READ_MEDIA_AUDIO,
        Manifest.permission.READ_MEDIA_VIDEO,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

internal fun canReadAudio(context: Context): Boolean = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED
    else -> ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
}

internal fun canReadVideo(context: Context): Boolean = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED
    else -> ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
}

private fun String.normalizedUnknown(fallback: String): String =
    takeUnless { it.isBlank() || it == MediaStore.UNKNOWN_STRING } ?: fallback
