package jp.tanaka.tcloud.ui

internal const val DOUBLE_TAP_SEEK_CONTROLS_HOLD_MS = 900L

internal class DoubleTapSeekControlsHold {
    private var sequence = 0L
    private var activeToken = 0L

    val isHolding: Boolean
        get() = activeToken != 0L

    fun begin(): Long {
        sequence += 1L
        activeToken = sequence
        return activeToken
    }

    fun complete(token: Long): Boolean {
        if (token != activeToken) return false
        activeToken = 0L
        return true
    }
}
