package jp.tanaka.tcloud.backup

internal data class CameraMediaAsset(
    val id: Long,
    val mediaType: Int,
    val sizeBytes: Long,
    val modifiedSeconds: Long,
    val dateAddedSeconds: Long,
    val uri: String,
)

internal data class CameraBackupPlan(
    val pending: List<Pair<String, CameraMediaAsset>>,
    val cursorDateAddedSeconds: Long,
    val cursorMediaId: Long,
    val reachedBatchLimit: Boolean,
)

internal fun planCameraBackup(
    folderId: Long,
    assets: List<CameraMediaAsset>,
    completedKeys: Set<String>,
    batchLimit: Int,
): CameraBackupPlan {
    require(folderId > 0)
    require(batchLimit > 0)
    val ordered = assets
        .asSequence()
        .filter { it.id > 0 && it.sizeBytes > 0 && it.dateAddedSeconds >= 0 }
        .sortedWith(compareBy<CameraMediaAsset> { it.dateAddedSeconds }.thenBy { it.id })
        .take(batchLimit)
        .toList()
    val pending = ordered.mapNotNull { asset ->
        val key = "$folderId:${asset.mediaType}:${asset.id}:${asset.modifiedSeconds}:${asset.sizeBytes}"
        if (key in completedKeys) null else key to asset
    }
    val cursor = ordered.lastOrNull()
    return CameraBackupPlan(
        pending = pending,
        cursorDateAddedSeconds = cursor?.dateAddedSeconds ?: 0,
        cursorMediaId = cursor?.id ?: 0,
        reachedBatchLimit = ordered.size >= batchLimit,
    )
}

internal fun cameraMediaKind(
    mediaType: Int,
    mimeType: String,
    includeImages: Boolean,
    includeVideos: Boolean,
): String? = when {
    includeImages && mediaType == CAMERA_MEDIA_IMAGE && mimeType.startsWith("image/", ignoreCase = true) -> "image"
    includeVideos && mediaType == CAMERA_MEDIA_VIDEO && mimeType.startsWith("video/", ignoreCase = true) -> "video"
    else -> null
}

internal const val CAMERA_MEDIA_IMAGE = 1
internal const val CAMERA_MEDIA_VIDEO = 3
