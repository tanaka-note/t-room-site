package jp.tanaka.tcloud.crypto

import jp.tanaka.tcloud.data.AccountCredentials
import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import jp.tanaka.tcloud.data.FileMetadata
import jp.tanaka.tcloud.data.FolderCredentials
import jp.tanaka.tcloud.data.EncryptedFilePayload
import jp.tanaka.tcloud.data.EncryptedFileMetadata
import jp.tanaka.tcloud.data.WrappedFileKey
import jp.tanaka.tcloud.data.WrappedFolderKey
import jp.tanaka.tcloud.data.SharePayload
import jp.tanaka.tcloud.data.ShareSelectedFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

object TCloudCrypto {
    private const val ACCOUNT_SALT_CONTEXT = "T-ROOM Cloud Storage account key v1|tanaka-note.com|"
    private const val ACCOUNT_AUTH_CONTEXT = "T-ROOM Cloud Storage account authentication v1"
    private const val ADMIN_WRAP_CONTEXT = "T-ROOM Cloud Storage admin private key v1"
    private const val FOLDER_AUTH_CONTEXT = "T-ROOM Cloud Storage folder authentication v1"
    private const val FOLDER_WRAP_CONTEXT = "T-ROOM Cloud Storage folder key v1"
    private const val PARENT_FOLDER_WRAP_CONTEXT = "T-ROOM Cloud Storage child folder key v1"
    private const val FOLDER_NAME_CONTEXT = "T-ROOM Cloud Storage folder name v1"
    private const val SHARE_AUTH_CONTEXT = "T-ROOM Cloud Storage share authentication v1"
    private const val SHARE_WRAP_CONTEXT = "T-ROOM Cloud Storage share key v1"
    private const val SHARE_TOKEN_CONTEXT = "T-ROOM Cloud Storage share token v1"
    private const val SHARE_FILE_KEY_CONTEXT = "T-ROOM Cloud Storage selected file key v1"
    private const val FILE_KEY_CONTEXT = "T-ROOM Cloud Storage file key v1"
    private const val FILE_METADATA_CONTEXT = "T-ROOM Cloud Storage file metadata v1"
    private const val FILE_CHUNK_CONTEXT = "T-ROOM Cloud Storage file chunk v1"

    class FileDecryptor internal constructor(
        private val fileKey: ByteArray,
    ) : AutoCloseable {
        fun decryptChunk(envelope: ByteArray, index: Int): ByteArray {
            require(index >= 0) { "暗号チャンク番号が不正です。" }
            require(
                envelope.size >= 32 &&
                    envelope[0] == 0x54.toByte() && envelope[1] == 0x52.toByte() &&
                    envelope[2] == 0x43.toByte() && envelope[3] == 0x31.toByte(),
            ) { "暗号チャンクの形式が不正です。" }
            return decryptAesGcm(
                key = fileKey,
                ciphertext = envelope.copyOfRange(16, envelope.size),
                iv = envelope.copyOfRange(4, 16),
                additionalData = "$FILE_CHUNK_CONTEXT|$index".toByteArray(),
            )
        }

        override fun close() {
            fileKey.fill(0)
        }
    }

    class PreparedFile internal constructor(
        val payload: EncryptedFilePayload,
        private val fileKey: ByteArray,
    ) : AutoCloseable {
        fun encryptChunk(plain: ByteArray, index: Int): ByteArray {
            require(index >= 0) { "暗号チャンク番号が不正です。" }
            val encrypted = encryptAesGcm(
                key = fileKey,
                plain = plain,
                additionalData = "$FILE_CHUNK_CONTEXT|$index".toByteArray(),
            )
            val envelope = ByteArray(4 + encrypted.iv.size + encrypted.ciphertext.size)
            envelope[0] = 0x54
            envelope[1] = 0x52
            envelope[2] = 0x43
            envelope[3] = 0x31
            encrypted.iv.copyInto(envelope, 4)
            encrypted.ciphertext.copyInto(envelope, 16)
            encrypted.iv.fill(0)
            encrypted.ciphertext.fill(0)
            return envelope
        }

        override fun close() {
            fileKey.fill(0)
        }
    }

    private data class EncryptedBytes(
        val iv: ByteArray,
        val ciphertext: ByteArray,
    )

    suspend fun deriveAccountCredentials(password: String, loginId: String): AccountCredentials =
        withContext(Dispatchers.Default) {
            require(password.length in 8..256) { "アカウントパスワードを確認してください。" }
            val normalizedLoginId = loginId.trim().lowercase()
            require(normalizedLoginId.isNotEmpty() && normalizedLoginId.length <= 254) {
                "ログインIDを確認してください。"
            }

            val salt = sha256("$ACCOUNT_SALT_CONTEXT$normalizedLoginId".toByteArray()).copyOfRange(0, 16)
            val master = deriveArgon2(password, salt)
            try {
                val accountKey = deriveContextKey(master, ADMIN_WRAP_CONTEXT)
                val authProof = base64Url(
                    hkdf(
                        inputKeyMaterial = master,
                        salt = ByteArray(32),
                        info = ACCOUNT_AUTH_CONTEXT.toByteArray(),
                        length = 32,
                    ),
                )
                AccountCredentials(accountKey, authProof)
            } finally {
                master.fill(0)
                salt.fill(0)
            }
        }

    suspend fun deriveFolderCredentials(folder: CloudFolder, password: String): FolderCredentials =
        withContext(Dispatchers.Default) {
            require(password.length in 4..128) { "フォルダのパスワードを確認してください。" }
            require(folder.passwordSalt.isNotBlank()) { "フォルダの暗号情報が不足しています。" }
            val salt = base64UrlDecode(folder.passwordSalt)
            val master = deriveArgon2(password, salt)
            try {
                val authProof = hmacProof(master, FOLDER_AUTH_CONTEXT)
                val wrappingKey = deriveContextKey(master, FOLDER_WRAP_CONTEXT)
                try {
                    val rawFolderKey = decryptAesGcm(
                        key = wrappingKey,
                        ciphertext = base64UrlDecode(folder.passwordWrappedKey),
                        iv = base64UrlDecode(folder.passwordWrapIv),
                        additionalData = FOLDER_WRAP_CONTEXT.toByteArray(),
                    )
                    FolderCredentials(rawFolderKey, authProof)
                } finally {
                    wrappingKey.fill(0)
                }
            } finally {
                master.fill(0)
                salt.fill(0)
            }
        }

    fun unlockAdminPrivateKey(
        accountKey: ByteArray,
        adminPrivateCipher: String,
        adminPrivateIv: String,
    ): PrivateKey {
        val privateKeyBytes = decryptAesGcm(
            key = accountKey,
            ciphertext = base64UrlDecode(adminPrivateCipher),
            iv = base64UrlDecode(adminPrivateIv),
            additionalData = ADMIN_WRAP_CONTEXT.toByteArray(),
        )
        return try {
            KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(privateKeyBytes))
        } finally {
            privateKeyBytes.fill(0)
        }
    }

    fun unlockFolderAsAdmin(folder: CloudFolder, privateKey: PrivateKey): ByteArray {
        require(folder.cryptoVersion == 1 && folder.adminWrappedKey.isNotBlank()) {
            "フォルダの暗号情報を確認してください。"
        }
        val cipher = Cipher.getInstance("RSA/ECB/OAEPPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            privateKey,
            OAEPParameterSpec(
                "SHA-256",
                "MGF1",
                MGF1ParameterSpec.SHA256,
                PSource.PSpecified.DEFAULT,
            ),
        )
        return cipher.doFinal(base64UrlDecode(folder.adminWrappedKey))
    }

    fun unlockFolderFromParent(folder: CloudFolder, parentFolderKey: ByteArray): ByteArray {
        require(folder.parentWrappedKey.isNotBlank() && folder.parentWrapIv.isNotBlank()) {
            "親フォルダの暗号情報が不足しています。"
        }
        return decryptAesGcm(
            key = parentFolderKey,
            ciphertext = base64UrlDecode(folder.parentWrappedKey),
            iv = base64UrlDecode(folder.parentWrapIv),
            additionalData = PARENT_FOLDER_WRAP_CONTEXT.toByteArray(),
        )
    }

    fun decryptFolderName(folder: CloudFolder, folderKey: ByteArray): String {
        if (folder.cryptoVersion != 1 || folder.encryptedName.isBlank()) return folder.name
        val bytes = decryptAesGcm(
            key = folderKey,
            ciphertext = base64UrlDecode(folder.encryptedName),
            iv = base64UrlDecode(folder.nameIv),
            additionalData = FOLDER_NAME_CONTEXT.toByteArray(),
        )
        return try {
            bytes.toString(Charsets.UTF_8).trim().ifBlank { folder.name }
        } finally {
            bytes.fill(0)
        }
    }

    fun decryptFileMetadata(file: CloudFile, folderKey: ByteArray): FileMetadata {
        if (file.cryptoVersion != 1) {
            return FileMetadata(file.name, file.mimeType, file.mediaKind, file.lastModified)
        }
        val fileKey = decryptAesGcm(
            key = folderKey,
            ciphertext = base64UrlDecode(file.wrappedFileKey),
            iv = base64UrlDecode(file.fileKeyIv),
            additionalData = FILE_KEY_CONTEXT.toByteArray(),
        )
        return try {
            val metadataBytes = decryptAesGcm(
                key = fileKey,
                ciphertext = base64UrlDecode(file.encryptedMetadata),
                iv = base64UrlDecode(file.metadataIv),
                additionalData = FILE_METADATA_CONTEXT.toByteArray(),
            )
            try {
                val metadata = JSONObject(metadataBytes.toString(Charsets.UTF_8))
                FileMetadata(
                    name = metadata.getString("name"),
                    mimeType = metadata.optString("mimeType", "application/octet-stream"),
                    mediaKind = metadata.optString("mediaKind", file.mediaKind),
                    lastModified = metadata.optLong("lastModified", 0),
                )
            } finally {
                metadataBytes.fill(0)
            }
        } finally {
            fileKey.fill(0)
        }
    }

    fun createFileDecryptor(file: CloudFile, folderKey: ByteArray): FileDecryptor {
        require(file.cryptoVersion == 1) { "暗号化されていないファイルです。" }
        val fileKey = decryptAesGcm(
            key = folderKey,
            ciphertext = base64UrlDecode(file.wrappedFileKey),
            iv = base64UrlDecode(file.fileKeyIv),
            additionalData = FILE_KEY_CONTEXT.toByteArray(),
        )
        return FileDecryptor(fileKey)
    }

    fun rewrapFileForFolder(
        file: CloudFile,
        sourceFolderKey: ByteArray,
        destinationFolderKey: ByteArray,
    ): WrappedFileKey {
        require(file.cryptoVersion == 1) { "暗号化されていないファイルです。" }
        val fileKey = decryptAesGcm(
            key = sourceFolderKey,
            ciphertext = base64UrlDecode(file.wrappedFileKey),
            iv = base64UrlDecode(file.fileKeyIv),
            additionalData = FILE_KEY_CONTEXT.toByteArray(),
        )
        return try {
            val wrapped = encryptAesGcm(
                key = destinationFolderKey,
                plain = fileKey,
                additionalData = FILE_KEY_CONTEXT.toByteArray(),
            )
            try {
                WrappedFileKey(
                    wrappedFileKey = base64Url(wrapped.ciphertext),
                    fileKeyIv = base64Url(wrapped.iv),
                )
            } finally {
                wrapped.iv.fill(0)
                wrapped.ciphertext.fill(0)
            }
        } finally {
            fileKey.fill(0)
        }
    }

    fun encryptRenamedFileMetadata(
        file: CloudFile,
        folderKey: ByteArray,
        newName: String,
    ): EncryptedFileMetadata {
        val cleanName = newName.trim()
        require(cleanName.isNotEmpty() && cleanName.length <= 240) { "ファイル名を確認してください。" }
        require(file.cryptoVersion == 1 && file.metadataDecrypted) { "ファイルの暗号情報を確認してください。" }
        val fileKey = decryptAesGcm(
            key = folderKey,
            ciphertext = base64UrlDecode(file.wrappedFileKey),
            iv = base64UrlDecode(file.fileKeyIv),
            additionalData = FILE_KEY_CONTEXT.toByteArray(),
        )
        val metadata = JSONObject()
            .put("name", cleanName)
            .put("mimeType", file.mimeType.ifBlank { "application/octet-stream" })
            .put("mediaKind", file.mediaKind)
            .put("lastModified", file.lastModified)
            .toString()
            .toByteArray(Charsets.UTF_8)
        return try {
            val encrypted = encryptAesGcm(fileKey, metadata, FILE_METADATA_CONTEXT.toByteArray())
            try {
                EncryptedFileMetadata(
                    encryptedMetadata = base64Url(encrypted.ciphertext),
                    metadataIv = base64Url(encrypted.iv),
                )
            } finally {
                encrypted.iv.fill(0)
                encrypted.ciphertext.fill(0)
            }
        } finally {
            metadata.fill(0)
            fileKey.fill(0)
        }
    }

    fun rewrapFolderForParent(
        folderKey: ByteArray,
        destinationParentKey: ByteArray,
    ): WrappedFolderKey {
        require(folderKey.size == 32 && destinationParentKey.size == 32) { "フォルダの暗号鍵を確認してください。" }
        val wrapped = encryptAesGcm(
            key = destinationParentKey,
            plain = folderKey,
            additionalData = PARENT_FOLDER_WRAP_CONTEXT.toByteArray(),
        )
        return try {
            WrappedFolderKey(
                parentWrappedKey = base64Url(wrapped.ciphertext),
                parentWrapIv = base64Url(wrapped.iv),
            )
        } finally {
            wrapped.iv.fill(0)
            wrapped.ciphertext.fill(0)
        }
    }

    fun createFileSharePayload(
        file: CloudFile,
        folderKey: ByteArray,
        password: String,
        expiresAt: Long,
    ): SharePayload {
        val fileKey = decryptAesGcm(
            key = folderKey,
            ciphertext = base64UrlDecode(file.wrappedFileKey),
            iv = base64UrlDecode(file.fileKeyIv),
            additionalData = FILE_KEY_CONTEXT.toByteArray(),
        )
        return try {
            createSharePayload(fileKey, password, "file", file.id, expiresAt)
        } finally {
            fileKey.fill(0)
        }
    }

    fun createFolderSharePayload(
        folder: CloudFolder,
        folderKey: ByteArray,
        password: String,
        expiresAt: Long,
    ): SharePayload = createSharePayload(folderKey, password, "folder", folder.id, expiresAt)

    fun createFileSelectionSharePayload(
        files: List<CloudFile>,
        folderKey: ByteArray,
        password: String,
        expiresAt: Long,
    ): SharePayload {
        require(files.size in 2..100 && files.all { it.cryptoVersion == 1 && it.metadataDecrypted }) {
            "共有するファイルは2件以上100件以内で選択してください。"
        }
        val fileKeys = files.map { file -> unwrapFileKey(file, folderKey) }
        return try {
            val targetKey = fileKeys.first()
            val selectedFiles = files.mapIndexed { index, file ->
                if (index == 0) {
                    ShareSelectedFile(id = file.id)
                } else {
                    val wrapped = encryptAesGcm(
                        key = targetKey,
                        plain = fileKeys[index],
                        additionalData = SHARE_FILE_KEY_CONTEXT.toByteArray(),
                    )
                    try {
                        ShareSelectedFile(
                            id = file.id,
                            shareWrappedFileKey = base64Url(wrapped.ciphertext),
                            shareFileKeyIv = base64Url(wrapped.iv),
                        )
                    } finally {
                        wrapped.iv.fill(0)
                        wrapped.ciphertext.fill(0)
                    }
                }
            }
            createSharePayload(targetKey, password, "selection", files.first().id, expiresAt)
                .copy(selectedFiles = selectedFiles)
        } finally {
            fileKeys.forEach { it.fill(0) }
        }
    }

    private fun unwrapFileKey(file: CloudFile, folderKey: ByteArray): ByteArray = decryptAesGcm(
        key = folderKey,
        ciphertext = base64UrlDecode(file.wrappedFileKey),
        iv = base64UrlDecode(file.fileKeyIv),
        additionalData = FILE_KEY_CONTEXT.toByteArray(),
    )

    private fun createSharePayload(
        targetKey: ByteArray,
        password: String,
        targetType: String,
        targetId: Long,
        expiresAt: Long,
    ): SharePayload {
        require(password.length in 12..128) { "共有パスワードは12文字以上128文字以内で設定してください。" }
        require(targetType in setOf("file", "folder", "selection") && targetId > 0) { "共有対象を確認してください。" }
        require(expiresAt > System.currentTimeMillis() / 1000 + 5 * 60) { "共有期限は5分以上先に設定してください。" }
        val tokenBytes = ByteArray(32).also(SecureRandom()::nextBytes)
        val token = base64Url(tokenBytes)
        val passwordSalt = ByteArray(16).also(SecureRandom()::nextBytes)
        val master = deriveArgon2(password, passwordSalt)
        return try {
            val authProof = hmacProof(master, SHARE_AUTH_CONTEXT)
            val wrappingKey = deriveContextKey(master, SHARE_WRAP_CONTEXT)
            try {
                val passwordWrapped = encryptAesGcm(
                    key = wrappingKey,
                    plain = targetKey,
                    additionalData = SHARE_WRAP_CONTEXT.toByteArray(),
                )
                val tokenPlain = token.toByteArray(Charsets.UTF_8)
                val encryptedToken = try {
                    encryptAesGcm(
                        key = targetKey,
                        plain = tokenPlain,
                        additionalData = SHARE_TOKEN_CONTEXT.toByteArray(),
                    )
                } finally {
                    tokenPlain.fill(0)
                }
                try {
                    SharePayload(
                        token = token,
                        targetType = targetType,
                        targetId = targetId,
                        expiresAt = expiresAt,
                        authProof = authProof,
                        encryptedToken = base64Url(encryptedToken.ciphertext),
                        tokenIv = base64Url(encryptedToken.iv),
                        passwordSalt = base64Url(passwordSalt),
                        passwordWrappedKey = base64Url(passwordWrapped.ciphertext),
                        passwordWrapIv = base64Url(passwordWrapped.iv),
                    )
                } finally {
                    passwordWrapped.iv.fill(0)
                    passwordWrapped.ciphertext.fill(0)
                    encryptedToken.iv.fill(0)
                    encryptedToken.ciphertext.fill(0)
                }
            } finally {
                wrappingKey.fill(0)
            }
        } finally {
            tokenBytes.fill(0)
            passwordSalt.fill(0)
            master.fill(0)
        }
    }

    fun createFilePackage(
        folderId: Long,
        folderKey: ByteArray,
        name: String,
        mimeType: String,
        mediaKind: String,
        lastModified: Long,
        sizeBytes: Long,
    ): PreparedFile {
        require(folderId > 0 && sizeBytes > 0) { "空ファイルはアップロード対象外です。" }
        require(name.isNotBlank() && name.length <= 240) { "ファイル名を確認してください。" }
        val rawFileKey = ByteArray(32).also(SecureRandom()::nextBytes)
        try {
            val metadata = JSONObject()
                .put("name", name)
                .put("mimeType", mimeType.ifBlank { "application/octet-stream" })
                .put("mediaKind", mediaKind)
                .put("lastModified", lastModified)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val encryptedMetadata = try {
                encryptAesGcm(rawFileKey, metadata, FILE_METADATA_CONTEXT.toByteArray())
            } finally {
                metadata.fill(0)
            }
            val wrappedFileKey = encryptAesGcm(folderKey, rawFileKey, FILE_KEY_CONTEXT.toByteArray())
            val chunkSize = chooseFileChunkSize(sizeBytes)
            val chunkCount = ((sizeBytes + chunkSize - 1) / chunkSize).toInt()
            check(chunkCount in 1..10_000) { "ファイルが大きすぎます。" }
            val payload = EncryptedFilePayload(
                folderId = folderId,
                sizeBytes = sizeBytes,
                encryptedMetadata = base64Url(encryptedMetadata.ciphertext),
                metadataIv = base64Url(encryptedMetadata.iv),
                wrappedFileKey = base64Url(wrappedFileKey.ciphertext),
                fileKeyIv = base64Url(wrappedFileKey.iv),
                encryptedSizeBytes = sizeBytes + chunkCount * 32L,
                chunkSizeBytes = chunkSize,
                chunkCount = chunkCount,
            )
            encryptedMetadata.iv.fill(0)
            encryptedMetadata.ciphertext.fill(0)
            wrappedFileKey.iv.fill(0)
            wrappedFileKey.ciphertext.fill(0)
            return PreparedFile(payload, rawFileKey.copyOf())
        } finally {
            rawFileKey.fill(0)
        }
    }

    internal fun hkdf(
        inputKeyMaterial: ByteArray,
        salt: ByteArray,
        info: ByteArray,
        length: Int,
    ): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(inputKeyMaterial)
        }
        val output = ByteArrayOutputStream(length)
        var previous = ByteArray(0)
        var counter = 1
        while (output.size() < length) {
            previous = Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(extract, "HmacSHA256"))
                update(previous)
                update(info)
                update(counter.toByte())
                doFinal()
            }
            output.write(previous)
            counter += 1
        }
        extract.fill(0)
        previous.fill(0)
        return output.toByteArray().copyOf(length)
    }

    private fun deriveArgon2(password: String, salt: ByteArray): ByteArray {
        val passwordBytes = password.toByteArray(Charsets.UTF_8)
        val output = ByteArray(32)
        val generator = Argon2BytesGenerator().apply {
            init(
                Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                    .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                    .withIterations(3)
                    .withMemoryAsKB(65_536)
                    .withParallelism(1)
                    .withSalt(salt)
                    .build(),
            )
        }
        return try {
            generator.generateBytes(passwordBytes, output)
            output
        } finally {
            passwordBytes.fill(0)
        }
    }

    private fun deriveContextKey(material: ByteArray, context: String): ByteArray = hkdf(
        inputKeyMaterial = material,
        salt = sha256("$context|salt".toByteArray()),
        info = context.toByteArray(),
        length = 32,
    )

    private fun hmacProof(master: ByteArray, context: String): String = base64Url(
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(master, "HmacSHA256"))
            doFinal(context.toByteArray())
        },
    )

    private fun decryptAesGcm(
        key: ByteArray,
        ciphertext: ByteArray,
        iv: ByteArray,
        additionalData: ByteArray,
    ): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        updateAAD(additionalData)
        doFinal(ciphertext)
    }

    private fun encryptAesGcm(
        key: ByteArray,
        plain: ByteArray,
        additionalData: ByteArray,
    ): EncryptedBytes {
        val iv = ByteArray(12).also(SecureRandom()::nextBytes)
        val ciphertext = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            updateAAD(additionalData)
            doFinal(plain)
        }
        return EncryptedBytes(iv, ciphertext)
    }

    private fun chooseFileChunkSize(sizeBytes: Long): Long {
        val minChunk = 8L * 1024 * 1024
        val maxChunk = 64L * 1024 * 1024
        val required = (sizeBytes + 9_999) / 10_000
        val rounded = ((required + minChunk - 1) / minChunk) * minChunk
        return rounded.coerceIn(minChunk, maxChunk)
    }

    private fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    private fun base64Url(value: ByteArray): String = Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(value)

    internal fun base64UrlDecode(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
}
