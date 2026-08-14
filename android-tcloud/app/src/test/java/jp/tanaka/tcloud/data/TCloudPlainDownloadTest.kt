package jp.tanaka.tcloud.data

import jp.tanaka.tcloud.crypto.TCloudCrypto
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

class TCloudPlainDownloadTest {
    @Test
    fun encryptedR2ChunksAreDecryptedBeforeEverySupportedFileTypeIsSaved() = runBlocking {
        val fixtures = listOf(
            Fixture("movie.mp4", "video/mp4", "video", byteArrayOf(0, 0, 0, 24) + "ftypisom-video".toByteArray()),
            Fixture("photo.jpg", "image/jpeg", "image", byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()) + "jpeg-image".toByteArray()),
            Fixture("notes.txt", "text/plain", "document", "T-Cloud text 日本語".toByteArray()),
            Fixture("report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document", "PK-docx-content".toByteArray()),
            Fixture("table.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document", "PK-xlsx-content".toByteArray()),
            Fixture("manual.pdf", "application/pdf", "document", "%PDF-1.7 content".toByteArray()),
            Fixture("release.apk", "application/vnd.android.package-archive", "other", "PK-apk-content".toByteArray()),
            Fixture(
                "archive.bin",
                "application/octet-stream",
                "other",
                ByteArray(8 * 1024 * 1024 + 257) { (it * 31).toByte() },
            ),
        )

        fixtures.forEachIndexed { index, fixture ->
            val folderKey = ByteArray(32) { (it + index + 11).toByte() }
            val prepared = TCloudCrypto.createFilePackage(
                folderId = 1,
                folderKey = folderKey,
                name = fixture.name,
                mimeType = fixture.mimeType,
                mediaKind = fixture.mediaKind,
                lastModified = 1_786_400_000_000,
                sizeBytes = fixture.bytes.size.toLong(),
            )
            prepared.use {
                val payload = prepared.payload
                val file = CloudFile(
                    id = index + 1L,
                    folderId = payload.folderId,
                    name = fixture.name,
                    mimeType = fixture.mimeType,
                    mediaKind = fixture.mediaKind,
                    sizeBytes = payload.sizeBytes,
                    cryptoVersion = payload.cryptoVersion,
                    encryptedMetadata = payload.encryptedMetadata,
                    metadataIv = payload.metadataIv,
                    wrappedFileKey = payload.wrappedFileKey,
                    fileKeyIv = payload.fileKeyIv,
                    chunkSizeBytes = payload.chunkSizeBytes,
                    chunkCount = payload.chunkCount,
                    hasThumbnail = false,
                    metadataDecrypted = true,
                )
                val encryptedChunks = (0 until payload.chunkCount).map { chunkIndex ->
                    val start = (chunkIndex * payload.chunkSizeBytes).toInt()
                    val end = minOf(start + payload.chunkSizeBytes.toInt(), fixture.bytes.size)
                    prepared.encryptChunk(fixture.bytes.copyOfRange(start, end), chunkIndex)
                }
                assertFalse(
                    "encrypted bytes must differ from the source",
                    encryptedChunks.first().contentEquals(fixture.bytes),
                )
                val saved = ByteArrayOutputStream()
                val progress = mutableListOf<Pair<Long, Long>>()

                TCloudCrypto.createFileDecryptor(file, folderKey).use { decryptor ->
                    TCloudPlainDownload.writeDecrypted(
                        file = file,
                        decryptor = decryptor,
                        output = saved,
                        loadEncryptedChunk = { chunkIndex -> encryptedChunks[chunkIndex].copyOf() },
                        onProgress = { done, total -> progress += done to total },
                    )
                }

                val downloaded = saved.toByteArray()
                assertEquals(fixture.bytes.size.toLong(), downloaded.size.toLong())
                assertArrayEquals(sha256(fixture.bytes), sha256(downloaded))
                assertArrayEquals(fixture.bytes, downloaded)
                assertEquals(payload.chunkCount, progress.size)
                assertEquals(fixture.bytes.size.toLong() to fixture.bytes.size.toLong(), progress.last())
                encryptedChunks.forEach { it.fill(0) }
                downloaded.fill(0)
            }
            fixture.bytes.fill(0)
            folderKey.fill(0)
        }
    }

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    private data class Fixture(
        val name: String,
        val mimeType: String,
        val mediaKind: String,
        val bytes: ByteArray,
    )
}
