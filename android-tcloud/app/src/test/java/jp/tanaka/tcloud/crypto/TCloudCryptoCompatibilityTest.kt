package jp.tanaka.tcloud.crypto

import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

class TCloudCryptoCompatibilityTest {
    @Test
    fun accountCredentialsMatchExistingWebImplementation() = runBlocking {
        val credentials = TCloudCrypto.deriveAccountCredentials(
            password = "CorrectHorseBattery1!",
            loginId = "test@example.com",
        )

        assertEquals(
            "OipNSd1glXR65fC3kA7lf1StrThLl8LFlD05PEghpBw",
            credentials.authProof,
        )
        assertEquals(
            "DlK0tGu_OqZx_kEOaB-ROsNSCAg7AMtlNiISxCHRBhw",
            Base64.getUrlEncoder().withoutPadding().encodeToString(credentials.accountKey),
        )
        credentials.accountKey.fill(0)
    }

    @Test
    fun hkdfMatchesRfc5869CaseOne() {
        val result = TCloudCrypto.hkdf(
            inputKeyMaterial = ByteArray(22) { 0x0b },
            salt = hex("000102030405060708090a0b0c"),
            info = hex("f0f1f2f3f4f5f6f7f8f9"),
            length = 42,
        )

        assertArrayEquals(
            hex("3cb25f25faacd57a90434f64d0362f2a" +
                "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
                "34007208d5b887185865"),
            result,
        )
    }

    @Test
    fun folderPasswordPackageMatchesExistingWebImplementation() = runBlocking {
        val folder = folderFixture().copy(
            passwordSalt = "AAECAwQFBgcICQoLDA0ODw",
            passwordWrapIv = "oKGio6Slpqeoqaqr",
            passwordWrappedKey = "HaU4FO7vcSVkBkAPqWjsr9EvzTntfFfw8I2hrWsifoAzdQkMcRTCIXt88Oybcl4i",
        )

        val credentials = TCloudCrypto.deriveFolderCredentials(folder, "FolderPass1")

        assertEquals("xV1WWytg-XfQ699mY7fh3Q8p9MKI7_3SMymOZJ0khSc", credentials.authProof)
        assertEquals(
            "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
            Base64.getUrlEncoder().withoutPadding().encodeToString(credentials.folderKey),
        )
        credentials.folderKey.fill(0)
    }

    @Test
    fun fileMetadataMatchesExistingWebImplementation() {
        val folderKey = ByteArray(32) { (it + 1).toByte() }
        val file = CloudFile(
            id = 7,
            folderId = 1,
            name = "",
            mimeType = "application/octet-stream",
            mediaKind = "video",
            sizeBytes = 123,
            cryptoVersion = 1,
            encryptedMetadata = "BRnpLTtJrTH9YYBIMRY5Bd13x0qVtQtNCtq-h-dCy1ZD6yB6maLJmVoI0Yeprkf1thdt7ghgCFFWrjFH4SrUgPgMg58PlQdOE4MpuMNWD0L_pPaDMT_AuQnANX9SkBaY7hYAdxfClwmgC49_Fwlh-tjg9A",
            metadataIv = "wMHCw8TFxsfIycrL",
            wrappedFileKey = "oeEM8LnN1bcugJj8CpLcPjAgShjqhgffrgVRkPa9XZRB_IqcVkFO3uYZSbCK34Bd",
            fileKeyIv = "sLGys7S1tre4ubq7",
            chunkSizeBytes = 8 * 1024 * 1024,
            chunkCount = 1,
            hasThumbnail = false,
        )

        val metadata = TCloudCrypto.decryptFileMetadata(file, folderKey)

        assertEquals("家族旅行.mp4", metadata.name)
        assertEquals("video/mp4", metadata.mimeType)
        assertEquals("video", metadata.mediaKind)
        assertEquals(1_786_400_000_000, metadata.lastModified)
        folderKey.fill(0)
    }

    @Test
    fun encryptedChunkMatchesExistingWebImplementation() {
        val folderKey = ByteArray(32) { (it + 1).toByte() }
        val file = fileFixture()
        val envelope = Base64.getUrlDecoder().decode(
            "VFJDMdDR0tPU1dbX2Nna21d7mFuNCsR_hcUCarMyLyUMlnKo70_oDhJ1UUnZi0lRnCt18Oec9zN4Bc4kuKdYmWQnwHo",
        )

        val plain = TCloudCrypto.createFileDecryptor(file, folderKey).use { decryptor ->
            decryptor.decryptChunk(envelope, 0)
        }

        assertEquals("T-Cloud Android chunk test 日本語", plain.toString(Charsets.UTF_8))
        plain.fill(0)
        folderKey.fill(0)
    }

    @Test
    fun androidUploadPackageCanBeReadByExistingFormat() {
        val folderKey = ByteArray(32) { (it + 71).toByte() }
        val plain = "Androidから暗号化して保存".toByteArray()
        val prepared = TCloudCrypto.createFilePackage(
            folderId = 5,
            folderKey = folderKey,
            name = "記録.txt",
            mimeType = "text/plain",
            mediaKind = "document",
            lastModified = 1_786_400_000_000,
            sizeBytes = plain.size.toLong(),
        )
        prepared.use {
            val payload = prepared.payload
            val file = CloudFile(
                id = 9,
                folderId = payload.folderId,
                name = "",
                mimeType = "application/octet-stream",
                mediaKind = "other",
                sizeBytes = payload.sizeBytes,
                cryptoVersion = payload.cryptoVersion,
                encryptedMetadata = payload.encryptedMetadata,
                metadataIv = payload.metadataIv,
                wrappedFileKey = payload.wrappedFileKey,
                fileKeyIv = payload.fileKeyIv,
                chunkSizeBytes = payload.chunkSizeBytes,
                chunkCount = payload.chunkCount,
                hasThumbnail = false,
            )
            val metadata = TCloudCrypto.decryptFileMetadata(file, folderKey)
            assertEquals("記録.txt", metadata.name)
            assertEquals("text/plain", metadata.mimeType)

            val envelope = prepared.encryptChunk(plain, 0)
            val restored = TCloudCrypto.createFileDecryptor(file, folderKey).use { decryptor ->
                decryptor.decryptChunk(envelope, 0)
            }
            assertArrayEquals(plain, restored)
            envelope.fill(0)
            restored.fill(0)
        }
        plain.fill(0)
        folderKey.fill(0)
    }

    @Test
    fun movingFileRewrapsOnlyTheFileKey() {
        val sourceFolderKey = ByteArray(32) { (it + 1).toByte() }
        val destinationFolderKey = ByteArray(32) { (it + 91).toByte() }
        val original = fileFixture()

        val wrapped = TCloudCrypto.rewrapFileForFolder(
            file = original,
            sourceFolderKey = sourceFolderKey,
            destinationFolderKey = destinationFolderKey,
        )
        val moved = original.copy(
            folderId = 99,
            wrappedFileKey = wrapped.wrappedFileKey,
            fileKeyIv = wrapped.fileKeyIv,
        )
        val metadata = TCloudCrypto.decryptFileMetadata(moved, destinationFolderKey)

        assertEquals("家族旅行.mp4", metadata.name)
        assertEquals("video/mp4", metadata.mimeType)
        assertEquals(original.encryptedMetadata, moved.encryptedMetadata)
        sourceFolderKey.fill(0)
        destinationFolderKey.fill(0)
    }

    @Test
    fun renamedMetadataKeepsFileCryptoAndMediaDetails() {
        val folderKey = ByteArray(32) { (it + 1).toByte() }
        val original = fileFixture().copy(
            name = "家族旅行.mp4",
            mimeType = "video/mp4",
            mediaKind = "video",
            lastModified = 1_786_400_000_000,
            metadataDecrypted = true,
        )

        val encrypted = TCloudCrypto.encryptRenamedFileMetadata(original, folderKey, "夏の旅行.mp4")
        val renamed = original.copy(
            encryptedMetadata = encrypted.encryptedMetadata,
            metadataIv = encrypted.metadataIv,
        )
        val metadata = TCloudCrypto.decryptFileMetadata(renamed, folderKey)

        assertEquals("夏の旅行.mp4", metadata.name)
        assertEquals("video/mp4", metadata.mimeType)
        assertEquals("video", metadata.mediaKind)
        assertEquals(1_786_400_000_000, metadata.lastModified)
        folderKey.fill(0)
    }

    @Test
    fun movedFolderKeyCanBeUnlockedOnlyByDestinationParent() {
        val folderKey = ByteArray(32) { (it + 21).toByte() }
        val destinationParentKey = ByteArray(32) { (it + 101).toByte() }
        val wrapped = TCloudCrypto.rewrapFolderForParent(folderKey, destinationParentKey)
        val movedFolder = folderFixture().copy(
            id = 44,
            parentId = 33,
            isProtected = false,
            parentWrappedKey = wrapped.parentWrappedKey,
            parentWrapIv = wrapped.parentWrapIv,
        )

        val restored = TCloudCrypto.unlockFolderFromParent(movedFolder, destinationParentKey)

        assertArrayEquals(folderKey, restored)
        restored.fill(0)
        folderKey.fill(0)
        destinationParentKey.fill(0)
    }

    @Test
    fun sharePackageUsesExistingCipherEnvelopeSizes() {
        val folderKey = ByteArray(32) { (it + 31).toByte() }
        val payload = TCloudCrypto.createFolderSharePayload(
            folder = folderFixture(),
            folderKey = folderKey,
            password = "StrongSharePassword1!",
            expiresAt = System.currentTimeMillis() / 1000 + 86_400,
        )

        assertEquals("folder", payload.targetType)
        assertEquals(1L, payload.targetId)
        assertEquals(43, payload.token.length)
        assertEquals(16, Base64.getUrlDecoder().decode(payload.passwordSalt).size)
        assertEquals(12, Base64.getUrlDecoder().decode(payload.passwordWrapIv).size)
        assertEquals(48, Base64.getUrlDecoder().decode(payload.passwordWrappedKey).size)
        assertEquals(12, Base64.getUrlDecoder().decode(payload.tokenIv).size)
        assertEquals(59, Base64.getUrlDecoder().decode(payload.encryptedToken).size)
        assertEquals(32, Base64.getUrlDecoder().decode(payload.authProof).size)
        folderKey.fill(0)
    }

    @Test
    fun multiFileShareWrapsEveryAdditionalFileKey() {
        val folderKey = ByteArray(32) { (it + 1).toByte() }
        val first = fileFixture().copy(
            name = "1.mp4",
            mimeType = "video/mp4",
            metadataDecrypted = true,
        )
        val prepared = TCloudCrypto.createFilePackage(
            folderId = 1,
            folderKey = folderKey,
            name = "2.mp4",
            mimeType = "video/mp4",
            mediaKind = "video",
            lastModified = 1_786_400_100_000,
            sizeBytes = 10,
        )
        prepared.use {
            val second = CloudFile(
                id = 8,
                folderId = 1,
                name = "2.mp4",
                mimeType = "video/mp4",
                mediaKind = "video",
                sizeBytes = 10,
                cryptoVersion = 1,
                encryptedMetadata = prepared.payload.encryptedMetadata,
                metadataIv = prepared.payload.metadataIv,
                wrappedFileKey = prepared.payload.wrappedFileKey,
                fileKeyIv = prepared.payload.fileKeyIv,
                chunkSizeBytes = prepared.payload.chunkSizeBytes,
                chunkCount = prepared.payload.chunkCount,
                hasThumbnail = false,
                metadataDecrypted = true,
            )
            val payload = TCloudCrypto.createFileSelectionSharePayload(
                files = listOf(first, second),
                folderKey = folderKey,
                password = "StrongSharePassword2!",
                expiresAt = System.currentTimeMillis() / 1000 + 86_400,
            )

            assertEquals("selection", payload.targetType)
            assertEquals(2, payload.selectedFiles.size)
            assertEquals(null, payload.selectedFiles.first().shareWrappedFileKey)
            assertEquals(48, Base64.getUrlDecoder().decode(payload.selectedFiles[1].shareWrappedFileKey!!).size)
            assertEquals(12, Base64.getUrlDecoder().decode(payload.selectedFiles[1].shareFileKeyIv!!).size)
        }
        folderKey.fill(0)
    }

    private fun fileFixture() = CloudFile(
        id = 7,
        folderId = 1,
        name = "",
        mimeType = "application/octet-stream",
        mediaKind = "video",
        sizeBytes = 123,
        cryptoVersion = 1,
        encryptedMetadata = "BRnpLTtJrTH9YYBIMRY5Bd13x0qVtQtNCtq-h-dCy1ZD6yB6maLJmVoI0Yeprkf1thdt7ghgCFFWrjFH4SrUgPgMg58PlQdOE4MpuMNWD0L_pPaDMT_AuQnANX9SkBaY7hYAdxfClwmgC49_Fwlh-tjg9A",
        metadataIv = "wMHCw8TFxsfIycrL",
        wrappedFileKey = "oeEM8LnN1bcugJj8CpLcPjAgShjqhgffrgVRkPa9XZRB_IqcVkFO3uYZSbCK34Bd",
        fileKeyIv = "sLGys7S1tre4ubq7",
        chunkSizeBytes = 8 * 1024 * 1024,
        chunkCount = 1,
        hasThumbnail = false,
    )

    private fun folderFixture() = CloudFolder(
        id = 1,
        parentId = null,
        name = "テスト",
        cryptoVersion = 1,
        encryptedName = "",
        nameIv = "",
        passwordSalt = "",
        passwordWrappedKey = "",
        passwordWrapIv = "",
        adminWrappedKey = "",
        parentWrappedKey = "",
        parentWrapIv = "",
        isProtected = true,
        isUnlocked = false,
        fileCount = 0,
        folderCount = 0,
    )

    private fun hex(value: String): ByteArray = value.chunked(2)
        .map { it.toInt(16).toByte() }
        .toByteArray()
}
