package jp.tanaka.troom.ai.data

/** Monotonic activity window; being visible alone does not keep a session alive. */
class ForegroundActivity(private val clockMillis: () -> Long) {
    private var foreground = false
    private var lastActivity = Long.MIN_VALUE

    @Synchronized fun resume() { foreground = true; lastActivity = clockMillis() }
    @Synchronized fun pause() { foreground = false }
    @Synchronized fun interact() { if (foreground) lastActivity = clockMillis() }
    @Synchronized fun isActive(): Boolean = foreground && clockMillis() - lastActivity in 0..60_000
}

object AiUserActivity {
    val window = ForegroundActivity { System.nanoTime() / 1_000_000 }
}
