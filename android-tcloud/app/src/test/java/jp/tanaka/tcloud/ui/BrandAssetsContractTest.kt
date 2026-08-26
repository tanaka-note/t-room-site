package jp.tanaka.tcloud.ui

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrandAssetsContractTest {
    @Test
    fun launcherAssetsMatchTheOfficialPlayer100Artwork() {
        val expectedSha256 = mapOf(
            "src/main/res/drawable/tcloud_launcher_foreground.xml" to
                "776b2b54842f5b17ebcd71814c7a2c9e5369822bccbdc5de0a61f21536b296de",
            "src/main/res/drawable/tcloud_launcher_monochrome.xml" to
                "7779067a17c01165a5f934f925c660773b17bf2be51eed530fa150ae9ef4a496",
            "src/main/res/drawable/tcloud_launcher_artwork.xml" to
                "1d679b4d1e931f2fb51b42bd6d31a495cf8d9a23a4f5a0ff32022226ed7a3cd0",
            "src/main/res/mipmap-anydpi-v26/ic_launcher.xml" to
                "89c6da2ca6187cd0b0140095b6d85e8ee8b2539300fe90a0773fabf57ddb0e7b",
            "src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml" to
                "89c6da2ca6187cd0b0140095b6d85e8ee8b2539300fe90a0773fabf57ddb0e7b",
            "src/main/res/drawable-nodpi/tcloud_logo.png" to
                "e617861d86c6b9d6f79c1263c45c93356b63537305bdb5fe1af5a176beb9faf2",
            "src/main/res/values/colors.xml" to
                "da9539acdbe8d4861882d7e0926d126284808ff1b8b5fb822373a08de57fb095",
        )

        expectedSha256.forEach { (path, expected) ->
            assertEquals("T-Cloud Player 1.0.0のブランド資産が変更されています: $path", expected, canonicalSha256(File(path)))
        }
    }

    @Test
    fun adaptiveIconsAndManifestKeepTheOfficialReferences() {
        val adaptiveIcons = listOf(
            File("src/main/res/mipmap-anydpi-v26/ic_launcher.xml"),
            File("src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml"),
        )
        adaptiveIcons.forEach { icon ->
            val source = icon.readText()
            assertTrue(source.contains("android:drawable=\"@color/launcher_background\""))
            assertTrue(source.contains("android:drawable=\"@drawable/tcloud_launcher_artwork\""))
            assertTrue(source.contains("android:drawable=\"@drawable/tcloud_launcher_monochrome\""))
        }

        val artwork = File("src/main/res/drawable/tcloud_launcher_artwork.xml").readText()
        assertTrue(artwork.contains("android:src=\"@drawable/tcloud_logo\""))

        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("android:icon=\"@mipmap/ic_launcher\""))
        assertTrue(manifest.contains("android:roundIcon=\"@mipmap/ic_launcher_round\""))
    }

    private fun canonicalSha256(file: File): String {
        val bytes = if (file.extension == "xml") {
            file.readText().replace("\r\n", "\n").toByteArray(Charsets.UTF_8)
        } else {
            file.readBytes()
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString(separator = "") { byte -> "%02x".format(byte) }
    }
}
