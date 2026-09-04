package jp.tanaka.tcloud.ui

import android.annotation.SuppressLint
import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.MotionEvent
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.DefaultTimeBar
import androidx.media3.ui.PlayerView
import androidx.media3.ui.TimeBar
import jp.tanaka.tcloud.R
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.math.max
import kotlin.math.roundToLong

internal fun relativeSeekPositionMs(
    playbackStartMs: Long,
    pointerStartX: Float,
    pointerCurrentX: Float,
    trackWidthPx: Int,
    durationMs: Long,
): Long {
    if (durationMs <= 0L || durationMs == C.TIME_UNSET) return 0L
    val clampedStart = playbackStartMs.coerceIn(0L, durationMs)
    if (!pointerStartX.isFinite() || !pointerCurrentX.isFinite()) return clampedStart
    val width = max(1, trackWidthPx).toDouble()
    val deltaMs = (pointerCurrentX.toDouble() - pointerStartX.toDouble()) / width * durationMs
    return (clampedStart + deltaMs).coerceIn(0.0, durationMs.toDouble()).roundToLong()
}

private data class RelativeSeekDrag(
    val pointerId: Int,
    val pointerStartX: Float,
    val playbackStartMs: Long,
)

@androidx.annotation.OptIn(UnstableApi::class)
class RelativeSeekTimeBar @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : DefaultTimeBar(context, attrs, defStyleAttr) {
    private val scrubListeners = CopyOnWriteArraySet<TimeBar.OnScrubListener>()
    private var boundPlayer: Player? = null
    private var knownDurationMs: Long = C.TIME_UNSET
    private var drag: RelativeSeekDrag? = null
    private var pendingPositionMs: Long = 0L

    fun bindPlayer(player: Player) {
        boundPlayer = player
    }

    override fun addListener(listener: TimeBar.OnScrubListener) {
        scrubListeners += listener
        super.addListener(listener)
    }

    override fun removeListener(listener: TimeBar.OnScrubListener) {
        scrubListeners -= listener
        super.removeListener(listener)
    }

    override fun setDuration(duration: Long) {
        knownDurationMs = duration
        super.setDuration(duration)
    }

    override fun setPosition(position: Long) {
        super.setPosition(if (drag == null) position else pendingPositionMs)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val activeDrag = drag
        if (activeDrag == null) {
            if (event.actionMasked != MotionEvent.ACTION_DOWN || !event.isRelativeSeekPointer()) {
                return super.onTouchEvent(event)
            }
            if (!isEnabled) return false
            val duration = activeDurationMs() ?: return false
            val playerPosition = boundPlayer?.currentPosition ?: 0L
            pendingPositionMs = playerPosition.coerceIn(0L, duration)
            drag = RelativeSeekDrag(
                pointerId = event.getPointerId(event.actionIndex),
                pointerStartX = event.getX(event.actionIndex),
                playbackStartMs = pendingPositionMs,
            )
            parent?.requestDisallowInterceptTouchEvent(true)
            super.setPosition(pendingPositionMs)
            scrubListeners.forEach { it.onScrubStart(this, pendingPositionMs) }
            return true
        }

        return when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val pointerIndex = event.findPointerIndex(activeDrag.pointerId)
                if (pointerIndex < 0) {
                    finishRelativeSeek(commit = true)
                } else {
                    previewRelativeSeek(event.getX(pointerIndex), activeDrag)
                }
                true
            }
            MotionEvent.ACTION_UP -> {
                val pointerIndex = event.findPointerIndex(activeDrag.pointerId)
                if (pointerIndex >= 0) previewRelativeSeek(event.getX(pointerIndex), activeDrag)
                finishRelativeSeek(commit = true)
                performClick()
                true
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.getPointerId(event.actionIndex) == activeDrag.pointerId) {
                    previewRelativeSeek(event.getX(event.actionIndex), activeDrag)
                    finishRelativeSeek(commit = true)
                }
                true
            }
            MotionEvent.ACTION_CANCEL -> {
                // The browser player commits the last previewed position on pointercancel too.
                finishRelativeSeek(commit = true)
                true
            }
            else -> true
        }
    }

    override fun performClick(): Boolean = super.performClick()

    private fun previewRelativeSeek(pointerX: Float, activeDrag: RelativeSeekDrag) {
        val duration = activeDurationMs() ?: return
        pendingPositionMs = relativeSeekPositionMs(
            playbackStartMs = activeDrag.playbackStartMs,
            pointerStartX = activeDrag.pointerStartX,
            pointerCurrentX = pointerX,
            trackWidthPx = width,
            durationMs = duration,
        )
        super.setPosition(pendingPositionMs)
        scrubListeners.forEach { it.onScrubMove(this, pendingPositionMs) }
    }

    private fun finishRelativeSeek(commit: Boolean) {
        if (drag == null) return
        drag = null
        parent?.requestDisallowInterceptTouchEvent(false)
        scrubListeners.forEach { it.onScrubStop(this, pendingPositionMs, !commit) }
        if (!commit) super.setPosition(boundPlayer?.currentPosition ?: 0L)
    }

    private fun activeDurationMs(): Long? {
        val playerDuration = boundPlayer?.duration
        return playerDuration
            ?.takeIf { it > 0L && it != C.TIME_UNSET }
            ?: knownDurationMs.takeIf { it > 0L && it != C.TIME_UNSET }
    }

    private fun MotionEvent.isRelativeSeekPointer(): Boolean {
        val toolType = getToolType(actionIndex)
        return toolType == MotionEvent.TOOL_TYPE_FINGER ||
            toolType == MotionEvent.TOOL_TYPE_STYLUS ||
            toolType == MotionEvent.TOOL_TYPE_ERASER
    }
}

@androidx.annotation.OptIn(UnstableApi::class)
@SuppressLint("InflateParams")
internal fun relativeSeekPlayerView(context: Context, player: Player): PlayerView =
    (LayoutInflater.from(context).inflate(R.layout.tcloud_relative_seek_player_view, null, false) as PlayerView)
        .apply {
            this.player = player
            bindRelativeSeekPlayer(player)
        }

@androidx.annotation.OptIn(UnstableApi::class)
internal fun PlayerView.bindRelativeSeekPlayer(player: Player) {
    findViewById<RelativeSeekTimeBar>(androidx.media3.ui.R.id.exo_progress)?.bindPlayer(player)
}
