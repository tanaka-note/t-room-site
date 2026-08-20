package jp.tanaka.tcloud.library

import jp.tanaka.tcloud.data.CloudFile
import jp.tanaka.tcloud.data.CloudFolder

enum class MediaSourceType {
    LOCAL,
    CLOUD,
    YOUTUBE,
}

enum class LibraryMediaType {
    AUDIO,
    VIDEO,
}

data class PlayableMediaItem(
    val stableId: String,
    val source: MediaSourceType,
    val mediaType: LibraryMediaType,
    val title: String,
    val fileName: String = "",
    val artist: String = "",
    val album: String = "",
    val trackNumber: Int = 0,
    val durationMs: Long = 0,
    val artworkUri: String = "",
    val location: String = "",
    val playbackUri: String = "",
    val favorite: Boolean = false,
    val watchLater: Boolean = false,
    val lastPlayedAt: Long = 0,
    val playbackPositionMs: Long = 0,
    val updatedAt: Long = 0,
    val addedAt: Long = 0,
    val tags: Set<String> = emptySet(),
    val channel: String = "",
    val youtubeVideoId: String = "",
    val cloudFile: CloudFile? = null,
    val cloudFolder: CloudFolder? = null,
    val cloudPathFolderIds: List<Long> = emptyList(),
)

data class MediaPlaylist(
    val id: Long,
    val name: String,
    val items: List<PlayableMediaItem> = emptyList(),
    val createdAt: Long = 0,
)

data class RecommendedMedia(
    val item: PlayableMediaItem,
    val reason: String,
    val saved: Boolean,
)

data class MediaLibraryState(
    val items: List<PlayableMediaItem> = emptyList(),
    val playlists: List<MediaPlaylist> = emptyList(),
    val recommendations: List<RecommendedMedia> = emptyList(),
    val refreshingLocal: Boolean = false,
    val refreshingCloud: Boolean = false,
    val refreshingYouTube: Boolean = false,
    val localPermissionGranted: Boolean = false,
    val youtubeOnlineAvailable: Boolean = true,
    val message: String? = null,
)

internal fun parseYouTubeVideoId(input: String): String? {
    val value = input.trim()
    if (YOUTUBE_VIDEO_ID.matches(value)) return value
    val uri = runCatching { java.net.URI(value) }.getOrNull() ?: return null
    val host = uri.host.orEmpty().lowercase().removePrefix("www.").removePrefix("m.")
    val path = uri.path.orEmpty().trim('/')
    val candidate = when {
        host == "youtu.be" -> path.substringBefore('/')
        host == "youtube.com" && path == "watch" -> queryParameter(uri.rawQuery, "v")
        host == "youtube.com" && path.startsWith("shorts/") -> path.removePrefix("shorts/").substringBefore('/')
        host == "youtube.com" && path.startsWith("embed/") -> path.removePrefix("embed/").substringBefore('/')
        host == "youtube.com" && path.startsWith("live/") -> path.removePrefix("live/").substringBefore('/')
        else -> null
    }
    return candidate?.takeIf(YOUTUBE_VIDEO_ID::matches)
}

private fun queryParameter(query: String?, name: String): String? = query.orEmpty()
    .split('&')
    .firstOrNull { it.substringBefore('=') == name }
    ?.substringAfter('=', "")
    ?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) }

internal fun mediaMatchesQuery(item: PlayableMediaItem, query: String): Boolean {
    val normalized = query.trim().lowercase()
    if (normalized.isEmpty()) return true
    return sequenceOf(
        item.title,
        item.fileName,
        item.artist,
        item.album,
        item.channel,
        item.location,
        item.tags.joinToString(" "),
    ).any { it.lowercase().contains(normalized) }
}

internal fun audioQueue(items: List<PlayableMediaItem>): List<PlayableMediaItem> =
    items.filter { it.mediaType == LibraryMediaType.AUDIO && it.source != MediaSourceType.YOUTUBE }

internal fun nextLibraryQueueIndex(current: Int, size: Int, direction: Int, repeatAll: Boolean): Int? {
    if (size <= 0 || current !in 0 until size || direction !in setOf(-1, 1)) return null
    val next = current + direction
    if (next in 0 until size) return next
    return if (repeatAll) if (direction > 0) 0 else size - 1 else null
}

internal fun recommendationTerms(items: List<PlayableMediaItem>, limit: Int = 3): List<String> {
    val weighted = linkedMapOf<String, Int>()
    items.forEach { item ->
        val weight = when {
            item.favorite -> 5
            item.watchLater -> 3
            item.lastPlayedAt > 0 -> 2
            else -> 0
        }
        if (weight == 0) return@forEach
        (item.tags + listOf(item.artist, item.channel))
            .map(String::trim)
            .filter { it.length in 2..80 && it !in UNKNOWN_LABELS }
            .forEach { term -> weighted[term] = (weighted[term] ?: 0) + weight }
    }
    return weighted.entries
        .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        .take(limit)
        .map { it.key }
}

internal fun recommendationReason(item: PlayableMediaItem, terms: List<String>): String {
    val matched = terms.firstOrNull { term ->
        sequenceOf(item.artist, item.channel, item.album, item.tags.joinToString(" "))
            .any { it.contains(term, ignoreCase = true) }
    }
    return matched?.let { "「$it」をよく再生しているため" }
        ?: if (item.favorite) "お気に入りに近い項目" else "最近の再生傾向に近いため"
}

internal fun youtubeWatchUrl(videoId: String): String = "https://www.youtube.com/watch?v=$videoId"

internal fun youtubeThumbnailUrl(videoId: String): String = "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"

private val YOUTUBE_VIDEO_ID = Regex("^[A-Za-z0-9_-]{11}$")
private val UNKNOWN_LABELS = setOf("不明なアーティスト", "不明なアルバム", "取得待ち")
