@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package jp.tanaka.tcloud.ui

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.net.Uri
import android.util.Rational
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PictureInPicture
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.WatchLater
import androidx.compose.material.icons.outlined.WatchLater
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import jp.tanaka.tcloud.library.LibraryMediaType
import jp.tanaka.tcloud.library.MediaLibraryState
import jp.tanaka.tcloud.library.MediaPlaylist
import jp.tanaka.tcloud.library.MediaSourceType
import jp.tanaka.tcloud.library.PlayableMediaItem
import jp.tanaka.tcloud.library.mediaMatchesQuery
import jp.tanaka.tcloud.media.PlaybackMode
import jp.tanaka.tcloud.media.TCloudPlaybackManager
import kotlinx.coroutines.delay

private enum class LibrarySection { RECENT, ALL, ARTIST, ALBUM, PLAYLIST, FAVORITE, WATCH_LATER, YOUTUBE, RECOMMENDED }

@Composable
internal fun MediaLibraryScreen(
    state: MediaLibraryState,
    playbackManager: TCloudPlaybackManager,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onRequestLocalPermission: () -> Unit,
    onOpen: (PlayableMediaItem) -> Unit,
    onLoadArtwork: suspend (PlayableMediaItem) -> Bitmap?,
    onSaveYouTube: suspend (String) -> PlayableMediaItem,
    onFavorite: (PlayableMediaItem, Boolean) -> Unit,
    onWatchLater: (PlayableMediaItem, Boolean) -> Unit,
    onCreatePlaylist: (String) -> Long,
    onAddToPlaylist: (Long, PlayableMediaItem) -> Unit,
    onSetTags: (PlayableMediaItem, Set<String>) -> Unit,
) {
    var mediaType by remember { mutableStateOf(LibraryMediaType.AUDIO) }
    var query by remember { mutableStateOf("") }
    var source by remember { mutableStateOf<MediaSourceType?>(null) }
    var section by remember(mediaType) { mutableStateOf(LibrarySection.RECENT) }
    var youtubeDialog by remember { mutableStateOf(false) }
    var playlistItem by remember { mutableStateOf<PlayableMediaItem?>(null) }
    var tagItem by remember { mutableStateOf<PlayableMediaItem?>(null) }
    val sections = if (mediaType == LibraryMediaType.AUDIO) {
        listOf(
            LibrarySection.RECENT to "最近再生", LibrarySection.ALL to "曲",
            LibrarySection.ARTIST to "アーティスト", LibrarySection.ALBUM to "アルバム",
            LibrarySection.PLAYLIST to "プレイリスト", LibrarySection.FAVORITE to "お気に入り",
        )
    } else {
        listOf(
            LibrarySection.RECENT to "最近再生", LibrarySection.ALL to "動画",
            LibrarySection.FAVORITE to "お気に入り", LibrarySection.WATCH_LATER to "あとで見る",
            LibrarySection.YOUTUBE to "YouTube", LibrarySection.RECOMMENDED to "おすすめ",
        )
    }
    val base = state.items.filter { item ->
        item.mediaType == mediaType && (source == null || item.source == source) && mediaMatchesQuery(item, query)
    }
    val displayed = when (section) {
        LibrarySection.RECENT -> base.filter { it.lastPlayedAt > 0 }.sortedByDescending { it.lastPlayedAt }
        LibrarySection.FAVORITE -> base.filter(PlayableMediaItem::favorite)
        LibrarySection.WATCH_LATER -> base.filter(PlayableMediaItem::watchLater)
        LibrarySection.YOUTUBE -> base.filter { it.source == MediaSourceType.YOUTUBE }
        LibrarySection.RECOMMENDED -> state.recommendations.map { it.item }.filter { it.mediaType == mediaType && mediaMatchesQuery(it, query) }
        else -> base.sortedBy { it.title.lowercase() }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("T-Cloud Player") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Storageへ戻る") } },
                actions = {
                    if (mediaType == LibraryMediaType.VIDEO) {
                        IconButton(onClick = { youtubeDialog = true }) { Icon(Icons.Default.Add, "YouTube URLを登録") }
                    }
                    IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, "ライブラリを更新") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = if (mediaType == LibraryMediaType.AUDIO) 0 else 1) {
                Tab(mediaType == LibraryMediaType.AUDIO, { mediaType = LibraryMediaType.AUDIO }, text = { Text("音楽") })
                Tab(mediaType == LibraryMediaType.VIDEO, { mediaType = LibraryMediaType.VIDEO }, text = { Text("動画") })
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("端末・T-Cloud・YouTubeを検索") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            )
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(horizontal = 12.dp)) {
                item { FilterChip(source == null, { source = null }, label = { Text("すべて") }) }
                items(MediaSourceType.entries) { item ->
                    FilterChip(source == item, { source = item }, label = { Text(item.sourceLabel()) })
                }
            }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(horizontal = 12.dp)) {
                items(sections) { (value, label) ->
                    AssistChip(onClick = { section = value }, label = {
                        Text(label, fontWeight = if (section == value) FontWeight.Bold else FontWeight.Normal)
                    })
                }
            }
            if (state.refreshingLocal || state.refreshingCloud || state.refreshingYouTube) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (!state.localPermissionGranted) {
                Row(
                    Modifier.fillMaxWidth().padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("端末メディア権限なし（T-Cloud / YouTubeは利用できます）", modifier = Modifier.weight(1f))
                    TextButton(onClick = onRequestLocalPermission) { Text("許可") }
                }
            }
            if (!state.youtubeOnlineAvailable && mediaType == LibraryMediaType.VIDEO) {
                Text(
                    "YouTubeオンライン情報はAPI設定後に利用できます。保存済みURLの公式再生は利用できます。",
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (section == LibrarySection.PLAYLIST) {
                PlaylistList(state.playlists, onOpen, onLoadArtwork)
            } else if (section == LibrarySection.ARTIST || section == LibrarySection.ALBUM) {
                GroupedMediaList(displayed, section, onOpen, onLoadArtwork, onFavorite, onWatchLater, { playlistItem = it }, { tagItem = it })
            } else {
                MediaItemsList(
                    displayed,
                    onOpen,
                    onLoadArtwork,
                    onFavorite,
                    onWatchLater,
                    { playlistItem = it },
                    { tagItem = it },
                    if (section == LibrarySection.RECOMMENDED) state.recommendations.associate { it.item.stableId to it.reason } else emptyMap(),
                )
            }
            if (mediaType == LibraryMediaType.AUDIO) {
                AudioQueueControls(playbackManager)
            }
        }
    }
    if (youtubeDialog) {
        YouTubeUrlDialog(onDismiss = { youtubeDialog = false }, onSave = onSaveYouTube)
    }
    playlistItem?.let { item ->
        PlaylistDialog(
            item = item,
            playlists = state.playlists,
            onDismiss = { playlistItem = null },
            onCreate = onCreatePlaylist,
            onAdd = onAddToPlaylist,
        )
    }
    tagItem?.let { item ->
        TagDialog(item, onDismiss = { tagItem = null }) { tags -> onSetTags(item, tags); tagItem = null }
    }
}

@Composable
private fun ColumnScope.MediaItemsList(
    items: List<PlayableMediaItem>,
    onOpen: (PlayableMediaItem) -> Unit,
    onLoadArtwork: suspend (PlayableMediaItem) -> Bitmap?,
    onFavorite: (PlayableMediaItem, Boolean) -> Unit,
    onWatchLater: (PlayableMediaItem, Boolean) -> Unit,
    onPlaylist: (PlayableMediaItem) -> Unit,
    onTags: (PlayableMediaItem) -> Unit,
    recommendationReasons: Map<String, String> = emptyMap(),
) {
    if (items.isEmpty()) {
        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { Text("該当するメディアはありません") }
        return
    }
    LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
        items(items, key = PlayableMediaItem::stableId) { item ->
            Row(
                Modifier.fillMaxWidth().clickable { onOpen(item) }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MediaArtwork(item, onLoadArtwork)
                Spacer(Modifier.size(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOf(item.artist.ifBlank { item.channel }, item.album, item.source.sourceLabel())
                            .filter(String::isNotBlank).joinToString(" ・ "),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    recommendationReasons[item.stableId]?.let { reason ->
                        Text(reason, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
                IconButton(onClick = { onFavorite(item, !item.favorite) }) {
                    Icon(if (item.favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, "お気に入り", tint = if (item.favorite) Color(0xFFE53935) else Color.Unspecified)
                }
                if (item.mediaType == LibraryMediaType.VIDEO) {
                    IconButton(onClick = { onWatchLater(item, !item.watchLater) }) {
                        Icon(if (item.watchLater) Icons.Default.WatchLater else Icons.Outlined.WatchLater, "あとで見る")
                    }
                }
                IconButton(onClick = { onPlaylist(item) }) { Icon(Icons.Default.PlaylistAdd, "プレイリストへ追加") }
                IconButton(onClick = { onTags(item) }) { Icon(Icons.Default.MoreVert, "タグを編集") }
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun ColumnScope.GroupedMediaList(
    items: List<PlayableMediaItem>,
    section: LibrarySection,
    onOpen: (PlayableMediaItem) -> Unit,
    onLoadArtwork: suspend (PlayableMediaItem) -> Bitmap?,
    onFavorite: (PlayableMediaItem, Boolean) -> Unit,
    onWatchLater: (PlayableMediaItem, Boolean) -> Unit,
    onPlaylist: (PlayableMediaItem) -> Unit,
    onTags: (PlayableMediaItem) -> Unit,
) {
    val groups = items.groupBy { if (section == LibrarySection.ARTIST) it.artist.ifBlank { "不明なアーティスト" } else it.album.ifBlank { "不明なアルバム" } }
    LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
        groups.toSortedMap().forEach { (name, group) ->
            item { Text(name, fontWeight = FontWeight.Bold, modifier = Modifier.padding(12.dp)) }
            items(group, key = PlayableMediaItem::stableId) { item ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(item) }.padding(16.dp, 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    MediaArtwork(item, onLoadArtwork)
                    Spacer(Modifier.size(10.dp))
                    Text(item.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = { onFavorite(item, !item.favorite) }) { Icon(if (item.favorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, "お気に入り") }
                    IconButton(onClick = { onPlaylist(item) }) { Icon(Icons.Default.PlaylistAdd, "プレイリストへ追加") }
                    IconButton(onClick = { onTags(item) }) { Icon(Icons.Default.MoreVert, "タグを編集") }
                }
            }
        }
    }
}

@Composable
private fun ColumnScope.PlaylistList(playlists: List<MediaPlaylist>, onOpen: (PlayableMediaItem) -> Unit, onLoadArtwork: suspend (PlayableMediaItem) -> Bitmap?) {
    LazyColumn(Modifier.fillMaxWidth().weight(1f)) {
        playlists.forEach { playlist ->
            item { Text(playlist.name, fontWeight = FontWeight.Bold, modifier = Modifier.padding(12.dp)) }
            items(playlist.items, key = { "${playlist.id}:${it.stableId}" }) { item ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(item) }.padding(horizontal = 24.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    MediaArtwork(item, onLoadArtwork)
                    Spacer(Modifier.size(10.dp))
                    Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun MediaArtwork(item: PlayableMediaItem, loader: suspend (PlayableMediaItem) -> Bitmap?) {
    val bitmap by produceState<Bitmap?>(initialValue = null, key1 = item.stableId, key2 = item.artworkUri) {
        value = loader(item)
    }
    Box(
        Modifier.size(52.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null) {
            Image(checkNotNull(bitmap).asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Icon(if (item.mediaType == LibraryMediaType.AUDIO) Icons.Default.PlayArrow else Icons.Default.PlayCircle, null)
        }
    }
}

@Composable
private fun AudioQueueControls(manager: TCloudPlaybackManager) {
    val mode by manager.playbackMode.collectAsState()
    val shuffle by manager.shuffle.collectAsState()
    var playing by remember { mutableStateOf(manager.player.isPlaying) }
    var position by remember { mutableFloatStateOf(manager.player.currentPosition.coerceAtLeast(0L).toFloat()) }
    var duration by remember { mutableFloatStateOf(manager.player.duration.coerceAtLeast(1L).toFloat()) }
    var seeking by remember { mutableStateOf(false) }
    LaunchedEffect(manager) {
        while (true) {
            playing = manager.player.isPlaying
            if (!seeking) position = manager.player.currentPosition.coerceAtLeast(0L).toFloat()
            duration = manager.player.duration.coerceAtLeast(1L).toFloat()
            delay(350)
        }
    }
    if (manager.currentStableId == null) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Text(manager.currentTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
        Slider(
            value = position.coerceIn(0f, duration),
            onValueChange = { seeking = true; position = it },
            onValueChangeFinished = { manager.player.seekTo(position.toLong()); seeking = false },
            valueRange = 0f..duration,
        )
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            IconButton(onClick = { manager.setShuffle(!shuffle) }) { Icon(Icons.Default.Shuffle, "シャッフル", tint = if (shuffle) MaterialTheme.colorScheme.primary else Color.Unspecified) }
            IconButton(onClick = { manager.skipPrevious() }) { Icon(Icons.Default.SkipPrevious, "前の曲") }
            IconButton(onClick = { if (playing) manager.player.pause() else manager.player.play() }) { Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "一時停止" else "再生") }
            IconButton(onClick = { manager.skipNext() }) { Icon(Icons.Default.SkipNext, "次の曲") }
            IconButton(onClick = {
                manager.setPlaybackMode(when (mode) { PlaybackMode.OFF -> PlaybackMode.REPEAT_ALL; PlaybackMode.REPEAT_ALL -> PlaybackMode.REPEAT_ONE; PlaybackMode.REPEAT_ONE -> PlaybackMode.OFF })
            }) { Icon(if (mode == PlaybackMode.REPEAT_ONE) Icons.Default.RepeatOne else Icons.Default.Repeat, "リピート", tint = if (mode == PlaybackMode.OFF) Color.Unspecified else MaterialTheme.colorScheme.primary) }
        }
    }
}

@Composable
private fun YouTubeUrlDialog(onDismiss: () -> Unit, onSave: suspend (String) -> PlayableMediaItem) {
    var value by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    LaunchedEffect(busy) {
        if (busy) runCatching { onSave(value) }.onSuccess { onDismiss() }.onFailure { error = it.message.orEmpty(); busy = false }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("YouTube動画リンクを保存") },
        text = { Column { OutlinedTextField(value, { value = it }, label = { Text("URL / video ID") }); if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error) } },
        confirmButton = { Button(onClick = { busy = true }, enabled = value.isNotBlank() && !busy) { Text("保存") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") } },
    )
}

@Composable
private fun PlaylistDialog(item: PlayableMediaItem, playlists: List<MediaPlaylist>, onDismiss: () -> Unit, onCreate: (String) -> Long, onAdd: (Long, PlayableMediaItem) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("プレイリストへ追加") },
        text = { Column { playlists.forEach { list -> TextButton(onClick = { onAdd(list.id, item); onDismiss() }) { Text(list.name) } }; OutlinedTextField(name, { name = it }, label = { Text("新しいプレイリスト") }) } },
        confirmButton = { Button(onClick = { val id = onCreate(name); onAdd(id, item); onDismiss() }, enabled = name.isNotBlank()) { Text("作成して追加") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

@Composable
private fun TagDialog(item: PlayableMediaItem, onDismiss: () -> Unit, onSave: (Set<String>) -> Unit) {
    var value by remember { mutableStateOf(item.tags.joinToString(", ")) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("検索タグ") },
        text = { OutlinedTextField(value, { value = it }, label = { Text("カンマ区切り") }) },
        confirmButton = { Button(onClick = { onSave(value.split(',').map(String::trim).filter(String::isNotBlank).toSet()) }) { Text("保存") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

@androidx.annotation.OptIn(UnstableApi::class)
@Composable
internal fun LibraryVideoPlayerScreen(
    item: PlayableMediaItem,
    playbackManager: TCloudPlaybackManager,
    pictureInPicture: Boolean,
    onClose: (Long, Long) -> Unit,
) {
    val context = LocalContext.current
    val activity = context as? Activity
    var fullscreen by remember { mutableStateOf(false) }
    val factory = remember(item.stableId) { playbackManager.createDataSourceFactory(item) }
    val player = remember(item.stableId) {
        ExoPlayer.Builder(context).build().apply {
            setMediaSource(ProgressiveMediaSource.Factory(factory).createMediaSource(MediaItem.fromUri(item.playbackUri.ifBlank { "tcloud://file/${item.cloudFile?.id}" })))
            prepare()
            if (item.playbackPositionMs > 0) seekTo(item.playbackPositionMs)
            playWhenReady = true
        }
    }
    DisposableEffect(player) {
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            onClose(player.currentPosition, player.duration)
            player.release()
            (factory as? AutoCloseable)?.close()
        }
    }
    BackHandler {
        if (fullscreen) {
            fullscreen = false
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        } else onClose(player.currentPosition, player.duration)
    }
    Column(Modifier.fillMaxSize()) {
        if (!fullscreen && !pictureInPicture) TopAppBar(
            title = { Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = { onClose(player.currentPosition, player.duration) }) { Icon(Icons.Default.ArrowBack, "戻る") } },
            actions = {
                IconButton(onClick = {
                    fullscreen = true
                    activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                }) { Icon(Icons.Default.Fullscreen, "全画面") }
                IconButton(onClick = { activity?.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build()) }) { Icon(Icons.Default.PictureInPicture, "PiP") }
            },
        )
        AndroidView(
            factory = { PlayerView(it).apply { this.player = player; useController = true } },
            update = { it.player = player },
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
internal fun YouTubePlayerScreen(item: PlayableMediaItem, applicationVisible: Boolean, onClose: () -> Unit) {
    val context = LocalContext.current
    val webView = remember(item.youtubeVideoId) {
        WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            webChromeClient = WebChromeClient()
            loadDataWithBaseURL(
                "https://tanaka-note.com/",
                youtubeEmbedHtml(item.youtubeVideoId),
                "text/html",
                "UTF-8",
                null,
            )
        }
    }
    LaunchedEffect(applicationVisible) {
        if (!applicationVisible) webView.evaluateJavascript("window.tcloudPause && window.tcloudPause()", null)
    }
    DisposableEffect(webView) { onDispose { webView.loadUrl("about:blank"); webView.stopLoading(); webView.destroy() } }
    BackHandler(onBack = onClose)
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }, navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Default.ArrowBack, "戻る") } })
        AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
    }
}

private fun youtubeEmbedHtml(videoId: String): String = """
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body,#player{width:100%;height:100%;margin:0;background:#000}</style></head>
<body><div id="player"></div><script src="https://www.youtube.com/iframe_api"></script><script>
var player; function onYouTubeIframeAPIReady(){ player=new YT.Player('player',{videoId:'$videoId',playerVars:{playsinline:1,autoplay:0,controls:1,rel:0},events:{}}); }
window.tcloudPause=function(){ if(player&&player.pauseVideo)player.pauseVideo(); };
</script></body></html>
""".trimIndent()

private fun MediaSourceType.sourceLabel(): String = when (this) {
    MediaSourceType.LOCAL -> "端末"
    MediaSourceType.CLOUD -> "T-Cloud"
    MediaSourceType.YOUTUBE -> "YouTube"
}
