package jp.tanaka.tcloud.data

data class Session(
    val authenticated: Boolean,
    val role: String = "",
    val accountName: String = "",
    val loginId: String = "",
    val canUpload: Boolean = false,
    val canDelete: Boolean = false,
) {
    val isAdmin: Boolean get() = role == "admin"
    val isSubAdmin: Boolean get() = role == "subadmin"
}

data class AuthMode(
    val mode: String,
    val credentialSalt: String = "",
)

data class CryptoConfig(
    val initialized: Boolean,
    val cryptoVersion: Int,
    val publicKeyJwk: String = "",
    val adminPrivateCipher: String = "",
    val adminPrivateIv: String = "",
)

data class EncryptedFolderPayload(
    val name: String,
    val cryptoVersion: Int = 1,
    val encryptedName: String,
    val nameIv: String,
    val adminWrappedKey: String,
    val parentWrappedKey: String = "",
    val parentWrapIv: String = "",
    val authProof: String = "",
    val passwordSalt: String = "",
    val passwordWrappedKey: String = "",
    val passwordWrapIv: String = "",
    val folderKey: ByteArray,
)

data class CloudFolder(
    val id: Long,
    val parentId: Long?,
    val name: String,
    val cryptoVersion: Int,
    val encryptedName: String,
    val nameIv: String,
    val passwordSalt: String,
    val passwordWrappedKey: String,
    val passwordWrapIv: String,
    val adminWrappedKey: String,
    val parentWrappedKey: String,
    val parentWrapIv: String,
    val isProtected: Boolean,
    val isUnlocked: Boolean,
    val fileCount: Int,
    val folderCount: Int,
    val createdAtMillis: Long = 0,
    val updatedAtMillis: Long = 0,
    val searchPath: String = "",
)

data class CloudFile(
    val id: Long,
    val folderId: Long,
    val name: String,
    val mimeType: String,
    val mediaKind: String,
    val sizeBytes: Long,
    val cryptoVersion: Int,
    val encryptedMetadata: String,
    val metadataIv: String,
    val wrappedFileKey: String,
    val fileKeyIv: String,
    val chunkSizeBytes: Long,
    val chunkCount: Int,
    val hasThumbnail: Boolean,
    val lastModified: Long = 0,
    val metadataDecrypted: Boolean = false,
    val createdAtMillis: Long = 0,
    val updatedAtMillis: Long = 0,
    val searchPath: String = "",
)

data class FolderPage(
    val currentFolder: CloudFolder?,
    val breadcrumbs: List<CloudFolder>,
    val folders: List<CloudFolder>,
    val files: List<CloudFile>,
    val canTrashContents: Boolean,
) {
    val currentFolderId: Long? get() = currentFolder?.id
}

data class CloudSearchPage(
    val folders: List<CloudFolder>,
    val files: List<CloudFile>,
    val keyFolders: List<CloudFolder>,
    val nextFolderOffset: Int?,
    val nextFileOffset: Int?,
)

data class CloudSearchResults(
    val folders: List<CloudFolder> = emptyList(),
    val files: List<CloudFile> = emptyList(),
    val truncated: Boolean = false,
)

data class CloudUsage(
    val activeFileCount: Int = 0,
    val activeBytes: Long = 0,
    val trashFileCount: Int = 0,
    val trashBytes: Long = 0,
)

data class CloudUsageFolder(
    val id: Long,
    val name: String,
    val fileCount: Int,
    val sizeBytes: Long,
)

data class TrashFile(
    val file: CloudFile,
    val folder: CloudFolder,
    val deletedAtMillis: Long,
)

data class TrashFolder(
    val folder: CloudFolder,
    val sizeBytes: Long,
    val deletedAtMillis: Long,
)

data class TrashPage(
    val files: List<TrashFile>,
    val folders: List<TrashFolder>,
)

data class AccountCredentials(
    val accountKey: ByteArray,
    val authProof: String,
)

data class FolderCredentials(
    val folderKey: ByteArray,
    val authProof: String,
)

data class FolderPasswordPackage(
    val authProof: String,
    val passwordSalt: String,
    val passwordWrappedKey: String,
    val passwordWrapIv: String,
)

data class FileMetadata(
    val name: String,
    val mimeType: String,
    val mediaKind: String,
    val lastModified: Long,
)

data class EncryptedFilePayload(
    val cryptoVersion: Int = 1,
    val folderId: Long,
    val sizeBytes: Long,
    val encryptedMetadata: String,
    val metadataIv: String,
    val wrappedFileKey: String,
    val fileKeyIv: String,
    val encryptedSizeBytes: Long,
    val chunkSizeBytes: Long,
    val chunkCount: Int,
)

data class UploadTicket(
    val id: Long,
    val uploadId: String,
    val chunkSize: Long,
)

data class UploadedPart(
    val partNumber: Int,
    val etag: String,
)

data class WrappedFileKey(
    val wrappedFileKey: String,
    val fileKeyIv: String,
)

data class EncryptedFileMetadata(
    val encryptedMetadata: String,
    val metadataIv: String,
)

data class WrappedFolderKey(
    val parentWrappedKey: String,
    val parentWrapIv: String,
)

data class SharePayload(
    val token: String,
    val targetType: String,
    val targetId: Long,
    val expiresAt: Long,
    val authProof: String,
    val encryptedToken: String,
    val tokenIv: String,
    val passwordSalt: String,
    val passwordWrappedKey: String,
    val passwordWrapIv: String,
    val selectedFiles: List<ShareSelectedFile> = emptyList(),
)

data class ShareSelectedFile(
    val id: Long,
    val shareWrappedFileKey: String? = null,
    val shareFileKeyIv: String? = null,
)

data class ShareResult(
    val url: String,
    val password: String,
    val expiresAt: Long,
)

data class MoveDestination(
    val id: Long,
    val parentId: Long?,
    val name: String,
    val isProtected: Boolean,
    val depth: Int,
)

class TCloudApiException(
    val statusCode: Int,
    override val message: String,
) : Exception(message)
