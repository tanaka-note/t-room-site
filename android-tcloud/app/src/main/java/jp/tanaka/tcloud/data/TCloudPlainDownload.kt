package jp.tanaka.tcloud.data

import jp.tanaka.tcloud.crypto.TCloudCrypto
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.OutputStream

/**
 * Writes only locally decrypted bytes to the user-selected Android destination.
 * Encrypted R2 chunks and the folder key never leave this device-side pipeline.
 */
internal object TCloudPlainDownload {
    suspend fun writeDecrypted(
        file: CloudFile,
        decryptor: TCloudCrypto.FileDecryptor,
        output: OutputStream,
        loadEncryptedChunk: suspend (index: Int) -> ByteArray,
        onProgress: suspend (downloadedBytes: Long, totalBytes: Long) -> Unit = { _, _ -> },
    ) {
        require(file.cryptoVersion == 1) { "暗号化ファイルの情報を確認してください。" }
        require(file.metadataDecrypted) { "元のファイル名・形式を復号できません。" }
        require(file.sizeBytes > 0 && file.chunkSizeBytes > 0 && file.chunkCount > 0) {
            "ファイル容量または暗号チャンク情報が不正です。"
        }

        var writtenBytes = 0L
        for (index in 0 until file.chunkCount) {
            currentCoroutineContext().ensureActive()
            val envelope = loadEncryptedChunk(index)
            try {
                val plain = decryptor.decryptChunk(envelope, index)
                try {
                    val expectedBytes = minOf(file.chunkSizeBytes, file.sizeBytes - writtenBytes)
                    check(expectedBytes > 0 && plain.size.toLong() == expectedBytes) {
                        "復号後のチャンク容量が一致しません。"
                    }
                    output.write(plain)
                    writtenBytes += plain.size
                    onProgress(writtenBytes, file.sizeBytes)
                } finally {
                    plain.fill(0)
                }
            } finally {
                envelope.fill(0)
            }
        }
        output.flush()
        check(writtenBytes == file.sizeBytes) { "復号後のファイル容量が一致しません。" }
    }
}
