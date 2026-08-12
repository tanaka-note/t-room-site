plugins {
    id("com.android.application") version "9.2.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.10" apply false
}

// Windowsの日本語パスとOneDrive同期によるテスト／APK生成物のロックを避ける。
// ソースとGit管理対象は引き続きこのリポジトリ内に置く。
val localBuildBase = file(
    (System.getenv("LOCALAPPDATA") ?: System.getProperty("java.io.tmpdir")) + "/TCloudAndroidBuild",
)
layout.buildDirectory.set(localBuildBase.resolve("root"))
subprojects {
    layout.buildDirectory.set(localBuildBase.resolve(name))
}
