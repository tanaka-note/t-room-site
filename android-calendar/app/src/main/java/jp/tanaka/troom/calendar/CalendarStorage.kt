package jp.tanaka.troom.calendar

import android.content.Context
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import android.system.Os
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Protected records never live in cacheDir, which Android may remove. */
class CalendarStorage(private val context: Context) {
    private val directory = File(context.noBackupFilesDir, "calendar").apply { mkdirs() }
    private val reserve = File(directory, "critical-reserve.bin")
    init { ensureReserve() }
    private fun ensureReserve() {
        if (reserve.length() >= 16L * 1024 * 1024 || directory.usableSpace < 96L * 1024 * 1024) return
        runCatching { RandomAccessFile(reserve, "rw").use { Os.posix_fallocate(it.fd, 0, 16L * 1024 * 1024) } }
    }
    @Synchronized fun write(name: String, json: JSONObject) {
        val plain = json.toString().toByteArray(Charsets.UTF_8)
        val allowance = if (name == "cache") json.optInt("budgetMiB", 100).toLong() * 1024 * 1024 else 8L * 1024 * 1024
        check(plain.size <= allowance) { "端末の保存上限に達しました。通信して同期するか、保存上限を変更してください。" }
        val critical = name == "reminders" || name == "auth"
        val needed = if (critical) maxOf(2L * 1024 * 1024, plain.size.toLong() * 3 + 1024 * 1024) else maxOf(64L * 1024 * 1024, plain.size.toLong() * 3 + 16L * 1024 * 1024)
        if (critical && directory.usableSpace < needed) reserve.delete()
        check(directory.usableSpace >= needed) { "端末の空き容量が少ないため、通知用の余力を確保して保存を中止しました。" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(name.toByteArray())
        val bytes = byteArrayOf(1) + cipher.iv + cipher.doFinal(plain)
        val target = AtomicFile(File(directory, "$name.bin"))
        val output = target.startWrite()
        try { output.write(bytes); target.finishWrite(output); ensureReserve() } catch (error: Throwable) { target.failWrite(output); throw error }
    }
    @Synchronized fun read(name: String): JSONObject? {
        val target = AtomicFile(File(directory, "$name.bin"))
        if (!target.baseFile.exists()) return null
        val bytes = target.openRead().use { it.readBytes() }
        check(bytes.size > 29 && bytes[0] == 1.toByte()) { "保存データを確認できません。" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(name.toByteArray())
        return JSONObject(cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8))
    }
    @Synchronized fun delete(name: String) { AtomicFile(File(directory, "$name.bin")).delete() }
    @Synchronized fun renewCookie(expected: String, replacement: String, expiresAt: Long?, serverNow: Long?) {
        val auth = read("auth") ?: return
        if (auth.optString("cookie") != expected) return
        auth.put("cookie", replacement)
        if (expiresAt != null) auth.put("expiresAt", expiresAt)
        if (serverNow != null) anchor(auth, serverNow)
        write("auth", auth)
    }
    fun anchor(auth: JSONObject, serverNow: Long) {
        auth.put("serverNow", serverNow).put("wallAtSync", System.currentTimeMillis()).put("elapsedAtSync", SystemClock.elapsedRealtime())
    }
    fun trustedNow(auth: JSONObject): Long {
        val wall = System.currentTimeMillis()
        val savedWall = auth.optLong("wallAtSync")
        check(savedWall > 0 && wall >= savedWall - 300000) { "端末の時刻を確認できません。オンラインで確認してください。" }
        val elapsed = SystemClock.elapsedRealtime() - auth.optLong("elapsedAtSync")
        val since = maxOf(wall - savedWall, if (elapsed >= 0) elapsed else 0)
        return auth.getLong("serverNow") + since / 1000
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("calendar-storage-v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("calendar-storage-v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
            generateKey()
        }
    }
}
