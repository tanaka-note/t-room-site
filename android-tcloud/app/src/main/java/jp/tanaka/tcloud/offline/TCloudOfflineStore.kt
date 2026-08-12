package jp.tanaka.tcloud.offline

import android.content.Context
import jp.tanaka.tcloud.data.CloudFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * R2から取得した暗号化チャンクを、復号せずにアプリ専用領域へ保存する。
 * 平文のファイル名・本文・動画データは永続化しない。
 */
class TCloudOfflineStore(context: Context) {
    private val root = File(context.filesDir, "tcloud_offline/v$FORMAT_VERSION")

    @Synchronized
    fun isComplete(file: CloudFile): Boolean {
        val directory = completeDirectory(file.id)
        val entry = readEntry(directory) ?: return false
        if (entry.file.folderId != file.folderId || entry.file.sizeBytes != file.sizeBytes ||
            entry.file.chunkSizeBytes != file.chunkSizeBytes || entry.file.chunkCount != file.chunkCount
        ) return false
        return (0 until file.chunkCount).all { index ->
            val chunk = chunkFile(directory, index)
            chunk.isFile && chunk.length() == expectedEnvelopeSize(file, index)
        }
    }

    @Synchronized
    fun prepare(file: CloudFile) {
        cleanupExpired()
        val complete = completeDirectory(file.id)
        if (complete.exists() && !isComplete(file)) {
            check(complete.deleteRecursively()) { "壊れた端末保存データを更新できませんでした。" }
        }
    }

    @Synchronized
    fun hasEncryptedChunk(file: CloudFile, index: Int): Boolean {
        val chunk = chunkFile(existingDirectory(file.id), index)
        return chunk.isFile && chunk.length() == expectedEnvelopeSize(file, index)
    }

    @Synchronized
    fun readEncryptedChunk(file: CloudFile, index: Int): ByteArray? {
        if (!hasEncryptedChunk(file, index)) return null
        return chunkFile(existingDirectory(file.id), index).readBytes()
    }

    @Synchronized
    fun writeEncryptedChunk(file: CloudFile, index: Int, envelope: ByteArray) {
        require(index in 0 until file.chunkCount) { "暗号化チャンク番号が不正です。" }
        require(envelope.size.toLong() == expectedEnvelopeSize(file, index)) {
            "暗号化チャンクの容量が一致しません。"
        }
        val directory = partialDirectory(file.id).apply { mkdirs() }
        check(directory.isDirectory) { "端末保存領域を作成できませんでした。" }
        val destination = chunkFile(directory, index)
        val temporary = File(directory, "${destination.name}.tmp")
        FileOutputStream(temporary).use { output ->
            output.write(envelope)
            output.fd.sync()
        }
        if (destination.exists()) check(destination.delete()) { "古い一時データを更新できませんでした。" }
        check(temporary.renameTo(destination)) { "暗号化データを確定できませんでした。" }
    }

    @Synchronized
    fun finish(file: CloudFile) {
        val partial = partialDirectory(file.id)
        check((0 until file.chunkCount).all { index ->
            val chunk = chunkFile(partial, index)
            chunk.isFile && chunk.length() == expectedEnvelopeSize(file, index)
        }) { "暗号化データがすべて揃っていません。" }

        val manifest = manifest(file, System.currentTimeMillis())
        val manifestFile = File(partial, MANIFEST_NAME)
        val temporaryManifest = File(partial, "$MANIFEST_NAME.tmp")
        temporaryManifest.writeText(manifest.toString(), Charsets.UTF_8)
        if (manifestFile.exists()) check(manifestFile.delete()) { "端末保存情報を更新できませんでした。" }
        check(temporaryManifest.renameTo(manifestFile)) { "端末保存情報を確定できませんでした。" }

        val complete = completeDirectory(file.id)
        if (complete.exists()) check(complete.deleteRecursively()) { "古い端末保存データを更新できませんでした。" }
        check(partial.renameTo(complete)) { "端末保存を完了できませんでした。" }
    }

    @Synchronized
    fun updateEncryptedMetadata(file: CloudFile) {
        val directory = completeDirectory(file.id)
        if (!directory.isDirectory) return
        val current = readEntry(directory) ?: return
        val savedAt = current.savedAtMillis
        val manifestFile = File(directory, MANIFEST_NAME)
        val temporary = File(directory, "$MANIFEST_NAME.tmp")
        temporary.writeText(manifest(file, savedAt).toString(), Charsets.UTF_8)
        if (manifestFile.exists()) check(manifestFile.delete()) { "端末保存情報を更新できませんでした。" }
        check(temporary.renameTo(manifestFile)) { "端末保存情報を確定できませんでした。" }
    }

    @Synchronized
    fun listCompleted(nowMillis: Long = System.currentTimeMillis()): List<OfflineEntry> {
        cleanupExpired(nowMillis)
        return root.listFiles().orEmpty()
            .filter { it.isDirectory && !it.name.startsWith(PARTIAL_PREFIX) }
            .mapNotNull(::readEntry)
            .sortedByDescending { it.savedAtMillis }
    }

    @Synchronized
    fun delete(fileId: Long): Boolean {
        val completeDeleted = !completeDirectory(fileId).exists() || completeDirectory(fileId).deleteRecursively()
        val partialDeleted = !partialDirectory(fileId).exists() || partialDirectory(fileId).deleteRecursively()
        return completeDeleted && partialDeleted
    }

    @Synchronized
    fun deleteForFolders(folderIds: Set<Long>): Int {
        if (folderIds.isEmpty()) return 0
        val matchingFileIds = root.listFiles().orEmpty()
            .filter { it.isDirectory }
            .mapNotNull(::readEntry)
            .filter { it.file.folderId in folderIds }
            .map { it.file.id }
            .distinct()
        matchingFileIds.forEach(::delete)
        return matchingFileIds.size
    }

    @Synchronized
    fun cleanupExpired(nowMillis: Long = System.currentTimeMillis()) {
        root.listFiles().orEmpty().forEach { directory ->
            if (!directory.isDirectory || directory.name.startsWith(PARTIAL_PREFIX)) return@forEach
            val entry = readEntry(directory)
            if (entry == null || entry.expiresAtMillis <= nowMillis) directory.deleteRecursively()
        }
    }

    private fun existingDirectory(fileId: Long): File {
        val complete = completeDirectory(fileId)
        return if (complete.isDirectory) complete else partialDirectory(fileId)
    }

    private fun completeDirectory(fileId: Long) = File(root, fileId.toString())

    private fun partialDirectory(fileId: Long) = File(root, "$PARTIAL_PREFIX$fileId")

    private fun chunkFile(directory: File, index: Int) = File(directory, "chunk-$index.bin")

    private fun expectedEnvelopeSize(file: CloudFile, index: Int): Long {
        require(index in 0 until file.chunkCount)
        val plainStart = index * file.chunkSizeBytes
        val plainSize = minOf(file.chunkSizeBytes, file.sizeBytes - plainStart)
        return plainSize + ENVELOPE_OVERHEAD_BYTES
    }

    private fun manifest(file: CloudFile, savedAtMillis: Long) = JSONObject()
        .put("formatVersion", FORMAT_VERSION)
        .put("fileId", file.id)
        .put("folderId", file.folderId)
        .put("sizeBytes", file.sizeBytes)
        .put("cryptoVersion", file.cryptoVersion)
        .put("encryptedMetadata", file.encryptedMetadata)
        .put("metadataIv", file.metadataIv)
        .put("wrappedFileKey", file.wrappedFileKey)
        .put("fileKeyIv", file.fileKeyIv)
        .put("chunkSizeBytes", file.chunkSizeBytes)
        .put("chunkCount", file.chunkCount)
        .put("hasThumbnail", file.hasThumbnail)
        .put("savedAtMillis", savedAtMillis)
        .put("expiresAtMillis", savedAtMillis + OFFLINE_TTL_MILLIS)

    private fun readEntry(directory: File): OfflineEntry? = runCatching {
        val json = JSONObject(File(directory, MANIFEST_NAME).readText(Charsets.UTF_8))
        check(json.getInt("formatVersion") == FORMAT_VERSION)
        val file = CloudFile(
            id = json.getLong("fileId"),
            folderId = json.getLong("folderId"),
            name = "暗号化オフラインファイル",
            mimeType = "application/octet-stream",
            mediaKind = "other",
            sizeBytes = json.getLong("sizeBytes"),
            cryptoVersion = json.getInt("cryptoVersion"),
            encryptedMetadata = json.getString("encryptedMetadata"),
            metadataIv = json.getString("metadataIv"),
            wrappedFileKey = json.getString("wrappedFileKey"),
            fileKeyIv = json.getString("fileKeyIv"),
            chunkSizeBytes = json.getLong("chunkSizeBytes"),
            chunkCount = json.getInt("chunkCount"),
            hasThumbnail = json.optBoolean("hasThumbnail", false),
        )
        OfflineEntry(
            file = file,
            savedAtMillis = json.getLong("savedAtMillis"),
            expiresAtMillis = json.getLong("expiresAtMillis"),
        )
    }.getOrNull()

    data class OfflineEntry(
        val file: CloudFile,
        val savedAtMillis: Long,
        val expiresAtMillis: Long,
    )

    private companion object {
        const val FORMAT_VERSION = 1
        const val MANIFEST_NAME = "manifest.json"
        const val PARTIAL_PREFIX = ".partial-"
        const val ENVELOPE_OVERHEAD_BYTES = 32L // TRC1 + IV + AES-GCM tag
        const val OFFLINE_TTL_MILLIS = 30L * 24 * 60 * 60 * 1000
    }
}
