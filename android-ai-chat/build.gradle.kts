plugins {
    id("com.android.application") version "9.2.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.10" apply false
}

// Windowsの日本語パスとOneDrive同期によるビルド成果物のロックを避ける。
val localBuildBase = file(
    (System.getenv("LOCALAPPDATA") ?: System.getProperty("java.io.tmpdir")) + "/AIChatByTRoomBuild",
)
layout.buildDirectory.set(localBuildBase.resolve("root"))
subprojects { layout.buildDirectory.set(localBuildBase.resolve(name)) }
