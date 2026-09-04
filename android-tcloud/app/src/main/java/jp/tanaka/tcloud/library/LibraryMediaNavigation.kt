package jp.tanaka.tcloud.library

internal enum class LibraryMediaDestination {
    AUDIO_NOW_PLAYING,
    VIDEO_PLAYER,
    YOUTUBE_PLAYER,
}

internal fun libraryMediaDestination(item: PlayableMediaItem): LibraryMediaDestination = when {
    item.source == MediaSourceType.YOUTUBE -> LibraryMediaDestination.YOUTUBE_PLAYER
    item.mediaType == LibraryMediaType.AUDIO -> LibraryMediaDestination.AUDIO_NOW_PLAYING
    else -> LibraryMediaDestination.VIDEO_PLAYER
}

/**
 * Keeps queue startup and navigation as one transition. Audio is selected only after the
 * existing queue accepts the item, so a playback failure cannot open a disconnected player UI.
 */
internal fun coordinateLibraryMediaOpen(
    item: PlayableMediaItem,
    startAudioQueue: (PlayableMediaItem) -> Unit,
    selectMedia: (PlayableMediaItem) -> Unit,
    recordStandalonePlayback: (PlayableMediaItem) -> Unit,
): LibraryMediaDestination {
    val destination = libraryMediaDestination(item)
    if (destination == LibraryMediaDestination.AUDIO_NOW_PLAYING) {
        startAudioQueue(item)
    }
    selectMedia(item)
    if (destination != LibraryMediaDestination.AUDIO_NOW_PLAYING) {
        recordStandalonePlayback(item)
    }
    return destination
}
