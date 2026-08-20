package jp.tanaka.tcloud.library

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import org.json.JSONArray
import org.json.JSONObject

class MediaLibraryStore(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DATABASE_NAME,
    null,
    DATABASE_VERSION,
) {
    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE media_items (
                stable_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                media_type TEXT NOT NULL,
                title TEXT NOT NULL,
                file_name TEXT NOT NULL DEFAULT '',
                artist TEXT NOT NULL DEFAULT '',
                album TEXT NOT NULL DEFAULT '',
                track_number INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                artwork_uri TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                playback_uri TEXT NOT NULL DEFAULT '',
                favorite INTEGER NOT NULL DEFAULT 0,
                watch_later INTEGER NOT NULL DEFAULT 0,
                last_played_at INTEGER NOT NULL DEFAULT 0,
                playback_position_ms INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL DEFAULT 0,
                tags_json TEXT NOT NULL DEFAULT '[]',
                channel TEXT NOT NULL DEFAULT '',
                youtube_video_id TEXT NOT NULL DEFAULT '',
                cloud_file_json TEXT,
                cloud_folder_json TEXT,
                cloud_path_ids TEXT NOT NULL DEFAULT '',
                cloud_scope_root_id INTEGER
            )""".trimIndent(),
        )
        db.execSQL("CREATE INDEX media_items_source_type_idx ON media_items(source, media_type, updated_at DESC)")
        db.execSQL("CREATE INDEX media_items_recent_idx ON media_items(last_played_at DESC)")
        db.execSQL(
            """CREATE TABLE playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )""".trimIndent(),
        )
        db.execSQL(
            """CREATE TABLE playlist_items (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                stable_id TEXT NOT NULL REFERENCES media_items(stable_id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                PRIMARY KEY (playlist_id, stable_id)
            )""".trimIndent(),
        )
        db.execSQL("CREATE INDEX playlist_items_order_idx ON playlist_items(playlist_id, position)")
        db.execSQL("CREATE TABLE library_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    fun readItems(): List<PlayableMediaItem> = readableDatabase.query(
        "media_items",
        null,
        null,
        null,
        null,
        null,
        "updated_at DESC, title COLLATE NOCASE ASC",
    ).use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.toMediaItem()) } }

    fun replaceLocal(items: List<PlayableMediaItem>) = replaceSource(MediaSourceType.LOCAL, null, items)

    fun replaceCloudScope(rootFolderId: Long, items: List<PlayableMediaItem>) =
        replaceSource(MediaSourceType.CLOUD, rootFolderId, items)

    fun upsertYouTube(item: PlayableMediaItem) = writableDatabase.transaction {
        upsertPreservingUserState(this, item, null)
    }

    fun clearCloud() = writableDatabase.delete(
        "media_items",
        "source = ?",
        arrayOf(MediaSourceType.CLOUD.name),
    )

    fun removeCloudPath(folderId: Long) {
        val token = ",$folderId,"
        writableDatabase.delete(
            "media_items",
            "source = ? AND instr(cloud_path_ids, ?) > 0",
            arrayOf(MediaSourceType.CLOUD.name, token),
        )
        removeCloudRoot(folderId)
    }

    fun cloudRootIds(): Set<Long> = readSetting(CLOUD_ROOTS_KEY).orEmpty()
        .split(',')
        .mapNotNull(String::toLongOrNull)
        .toSet()

    fun addCloudRoot(folderId: Long) = writeCloudRoots(cloudRootIds() + folderId)

    fun removeCloudRoot(folderId: Long) = writeCloudRoots(cloudRootIds() - folderId)

    fun clearCloudRoots() = writeCloudRoots(emptySet())

    fun setFavorite(stableId: String, favorite: Boolean) = updateFlag(stableId, "favorite", favorite)

    fun setWatchLater(stableId: String, watchLater: Boolean) = updateFlag(stableId, "watch_later", watchLater)

    fun setTags(stableId: String, tags: Set<String>) {
        writableDatabase.update(
            "media_items",
            ContentValues().apply { put("tags_json", JSONArray(tags.sorted()).toString()) },
            "stable_id = ?",
            arrayOf(stableId),
        )
    }

    fun recordPlayback(stableId: String, positionMs: Long, durationMs: Long, playedAt: Long) {
        val finished = durationMs > 0 && durationMs - positionMs <= 10_000L
        writableDatabase.update(
            "media_items",
            ContentValues().apply {
                put("last_played_at", playedAt)
                put("playback_position_ms", if (finished || positionMs < 5_000L) 0L else positionMs)
            },
            "stable_id = ?",
            arrayOf(stableId),
        )
    }

    fun updateCatalogMetadata(stableId: String, title: String?, artist: String?, album: String?, trackNumber: Int?) {
        val values = ContentValues().apply {
            title?.trim()?.takeIf { it.isNotBlank() }?.let { put("title", it.take(300)) }
            artist?.trim()?.takeIf { it.isNotBlank() }?.let { put("artist", it.take(200)) }
            album?.trim()?.takeIf { it.isNotBlank() }?.let { put("album", it.take(200)) }
            trackNumber?.takeIf { it > 0 }?.let { put("track_number", it) }
        }
        if (values.size() > 0) writableDatabase.update("media_items", values, "stable_id = ?", arrayOf(stableId))
    }

    fun createPlaylist(name: String): Long = writableDatabase.insertOrThrow(
        "playlists",
        null,
        ContentValues().apply {
            put("name", name.trim().take(120))
            put("created_at", System.currentTimeMillis())
        },
    )

    fun addToPlaylist(playlistId: Long, stableId: String) = writableDatabase.transaction {
        val next = rawQuery(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?",
            arrayOf(playlistId.toString()),
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else 0 }
        insertWithOnConflict(
            "playlist_items",
            null,
            ContentValues().apply {
                put("playlist_id", playlistId)
                put("stable_id", stableId)
                put("position", next)
            },
            SQLiteDatabase.CONFLICT_IGNORE,
        )
    }

    fun readPlaylists(items: List<PlayableMediaItem> = readItems()): List<MediaPlaylist> {
        val byId = items.associateBy(PlayableMediaItem::stableId)
        return readableDatabase.rawQuery(
            """SELECT p.id, p.name, p.created_at, pi.stable_id
               FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
               ORDER BY p.created_at DESC, pi.position ASC""".trimIndent(),
            null,
        ).use { cursor ->
            val grouped = linkedMapOf<Long, Triple<String, Long, MutableList<PlayableMediaItem>>>()
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val row = grouped.getOrPut(id) { Triple(cursor.getString(1), cursor.getLong(2), mutableListOf()) }
                if (!cursor.isNull(3)) byId[cursor.getString(3)]?.let(row.third::add)
            }
            grouped.map { (id, row) -> MediaPlaylist(id, row.first, row.third, row.second) }
        }
    }

    fun readSetting(key: String): String? = readableDatabase.query(
        "library_settings",
        arrayOf("value"),
        "key = ?",
        arrayOf(key),
        null,
        null,
        null,
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

    fun writeSetting(key: String, value: String) {
        writableDatabase.insertWithOnConflict(
            "library_settings",
            null,
            ContentValues().apply { put("key", key); put("value", value) },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    private fun replaceSource(source: MediaSourceType, cloudRootId: Long?, items: List<PlayableMediaItem>) {
        writableDatabase.transaction {
            items.forEach { upsertPreservingUserState(this, it, cloudRootId) }
            val ids = items.map(PlayableMediaItem::stableId).toSet()
            val selection = if (cloudRootId == null) {
                "source = ?"
            } else {
                "source = ? AND cloud_scope_root_id = ?"
            }
            val args = if (cloudRootId == null) {
                arrayOf(source.name)
            } else {
                arrayOf(source.name, cloudRootId.toString())
            }
            query("media_items", arrayOf("stable_id"), selection, args, null, null, null).use { cursor ->
                val stale = buildList { while (cursor.moveToNext()) if (cursor.getString(0) !in ids) add(cursor.getString(0)) }
                stale.forEach { delete("media_items", "stable_id = ?", arrayOf(it)) }
            }
        }
    }

    private fun upsertPreservingUserState(db: SQLiteDatabase, item: PlayableMediaItem, cloudRootId: Long?) {
        val values = item.toContentValues(cloudRootId)
        val updated = db.update("media_items", values, "stable_id = ?", arrayOf(item.stableId))
        if (updated == 0) {
            values.put("stable_id", item.stableId)
            values.put("favorite", item.favorite)
            values.put("watch_later", item.watchLater)
            values.put("last_played_at", item.lastPlayedAt)
            values.put("playback_position_ms", item.playbackPositionMs)
            db.insertOrThrow("media_items", null, values)
        }
    }

    private fun updateFlag(stableId: String, column: String, enabled: Boolean) {
        writableDatabase.update(
            "media_items",
            ContentValues().apply { put(column, if (enabled) 1 else 0) },
            "stable_id = ?",
            arrayOf(stableId),
        )
    }

    private fun writeCloudRoots(ids: Set<Long>) = writeSetting(CLOUD_ROOTS_KEY, ids.sorted().joinToString(","))

    private fun PlayableMediaItem.toContentValues(cloudRootId: Long?) = ContentValues().apply {
        put("source", source.name)
        put("media_type", mediaType.name)
        put("title", title)
        put("file_name", fileName)
        put("artist", artist)
        put("album", album)
        put("track_number", trackNumber)
        put("duration_ms", durationMs)
        put("artwork_uri", artworkUri)
        put("location", location)
        put("playback_uri", playbackUri)
        put("updated_at", updatedAt)
        put("added_at", addedAt)
        put("tags_json", JSONArray(tags.sorted()).toString())
        put("channel", channel)
        put("youtube_video_id", youtubeVideoId)
        if (cloudFile == null) putNull("cloud_file_json") else put("cloud_file_json", cloudFile.toJson().toString())
        if (cloudFolder == null) putNull("cloud_folder_json") else put("cloud_folder_json", cloudFolder.toJson().toString())
        put("cloud_path_ids", cloudPathFolderIds.joinToString(",", prefix = ",", postfix = ","))
        if (cloudRootId == null) putNull("cloud_scope_root_id") else put("cloud_scope_root_id", cloudRootId)
    }

    private fun Cursor.toMediaItem(): PlayableMediaItem = PlayableMediaItem(
        stableId = text("stable_id"),
        source = enumValueOf(text("source")),
        mediaType = enumValueOf(text("media_type")),
        title = text("title"),
        fileName = text("file_name"),
        artist = text("artist"),
        album = text("album"),
        trackNumber = int("track_number"),
        durationMs = long("duration_ms"),
        artworkUri = text("artwork_uri"),
        location = text("location"),
        playbackUri = text("playback_uri"),
        favorite = int("favorite") != 0,
        watchLater = int("watch_later") != 0,
        lastPlayedAt = long("last_played_at"),
        playbackPositionMs = long("playback_position_ms"),
        updatedAt = long("updated_at"),
        addedAt = long("added_at"),
        tags = JSONArray(text("tags_json")).toStringSet(),
        channel = text("channel"),
        youtubeVideoId = text("youtube_video_id"),
        cloudFile = nullableText("cloud_file_json")?.let { JSONObject(it).toCloudFile() },
        cloudFolder = nullableText("cloud_folder_json")?.let { JSONObject(it).toCloudFolder() },
        cloudPathFolderIds = text("cloud_path_ids").split(',').mapNotNull(String::toLongOrNull),
    )

    private fun Cursor.text(column: String): String = getString(getColumnIndexOrThrow(column)).orEmpty()
    private fun Cursor.nullableText(column: String): String? = getColumnIndexOrThrow(column).let { if (isNull(it)) null else getString(it) }
    private fun Cursor.long(column: String): Long = getLong(getColumnIndexOrThrow(column))
    private fun Cursor.int(column: String): Int = getInt(getColumnIndexOrThrow(column))

    private fun CloudFile.toJson() = JSONObject()
        .put("id", id).put("folderId", folderId).put("name", name).put("mimeType", mimeType)
        .put("mediaKind", mediaKind).put("sizeBytes", sizeBytes).put("cryptoVersion", cryptoVersion)
        .put("encryptedMetadata", encryptedMetadata).put("metadataIv", metadataIv)
        .put("wrappedFileKey", wrappedFileKey).put("fileKeyIv", fileKeyIv)
        .put("chunkSizeBytes", chunkSizeBytes).put("chunkCount", chunkCount)
        .put("hasThumbnail", hasThumbnail).put("lastModified", lastModified)
        .put("metadataDecrypted", metadataDecrypted).put("createdAtMillis", createdAtMillis)
        .put("updatedAtMillis", updatedAtMillis).put("searchPath", searchPath).put("searchDepth", searchDepth)

    private fun JSONObject.toCloudFile() = CloudFile(
        id = getLong("id"), folderId = getLong("folderId"), name = getString("name"),
        mimeType = getString("mimeType"), mediaKind = getString("mediaKind"), sizeBytes = getLong("sizeBytes"),
        cryptoVersion = getInt("cryptoVersion"), encryptedMetadata = getString("encryptedMetadata"),
        metadataIv = getString("metadataIv"), wrappedFileKey = getString("wrappedFileKey"), fileKeyIv = getString("fileKeyIv"),
        chunkSizeBytes = getLong("chunkSizeBytes"), chunkCount = getInt("chunkCount"), hasThumbnail = getBoolean("hasThumbnail"),
        lastModified = getLong("lastModified"), metadataDecrypted = getBoolean("metadataDecrypted"),
        createdAtMillis = getLong("createdAtMillis"), updatedAtMillis = getLong("updatedAtMillis"),
        searchPath = getString("searchPath"), searchDepth = getInt("searchDepth"),
    )

    private fun CloudFolder.toJson() = JSONObject()
        .put("id", id).put("parentId", parentId).put("name", name).put("cryptoVersion", cryptoVersion)
        .put("encryptedName", encryptedName).put("nameIv", nameIv).put("passwordSalt", passwordSalt)
        .put("passwordWrappedKey", passwordWrappedKey).put("passwordWrapIv", passwordWrapIv)
        .put("adminWrappedKey", adminWrappedKey).put("parentWrappedKey", parentWrappedKey).put("parentWrapIv", parentWrapIv)
        .put("isProtected", isProtected).put("isUnlocked", isUnlocked).put("fileCount", fileCount).put("folderCount", folderCount)
        .put("createdAtMillis", createdAtMillis).put("updatedAtMillis", updatedAtMillis)
        .put("searchPath", searchPath).put("searchDepth", searchDepth)

    private fun JSONObject.toCloudFolder() = CloudFolder(
        id = getLong("id"), parentId = if (isNull("parentId")) null else getLong("parentId"), name = getString("name"),
        cryptoVersion = getInt("cryptoVersion"), encryptedName = getString("encryptedName"), nameIv = getString("nameIv"),
        passwordSalt = getString("passwordSalt"), passwordWrappedKey = getString("passwordWrappedKey"),
        passwordWrapIv = getString("passwordWrapIv"), adminWrappedKey = getString("adminWrappedKey"),
        parentWrappedKey = getString("parentWrappedKey"), parentWrapIv = getString("parentWrapIv"),
        isProtected = getBoolean("isProtected"), isUnlocked = getBoolean("isUnlocked"), fileCount = getInt("fileCount"),
        folderCount = getInt("folderCount"), createdAtMillis = getLong("createdAtMillis"), updatedAtMillis = getLong("updatedAtMillis"),
        searchPath = getString("searchPath"), searchDepth = getInt("searchDepth"),
    )

    private fun JSONArray.toStringSet(): Set<String> = buildSet {
        for (index in 0 until length()) optString(index).trim().takeIf(String::isNotEmpty)?.let(::add)
    }

    private inline fun <T> SQLiteDatabase.transaction(block: SQLiteDatabase.() -> T): T {
        beginTransaction()
        return try {
            val result = block()
            setTransactionSuccessful()
            result
        } finally {
            endTransaction()
        }
    }

    companion object {
        private const val DATABASE_NAME = "tcloud_player_library.db"
        private const val DATABASE_VERSION = 1
        private const val CLOUD_ROOTS_KEY = "cloud_roots"
    }
}
