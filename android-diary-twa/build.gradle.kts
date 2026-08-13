plugins {
    id("com.android.application") version "9.2.1" apply false
}

val localBuildBase = file(
    (System.getenv("LOCALAPPDATA") ?: System.getProperty("java.io.tmpdir")) + "/TRoomDiaryTwaBuild",
)
layout.buildDirectory.set(localBuildBase.resolve("root"))
subprojects {
    layout.buildDirectory.set(localBuildBase.resolve(name))
}
