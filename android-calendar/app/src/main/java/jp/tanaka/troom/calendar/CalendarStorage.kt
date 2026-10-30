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

object CalendarSelectionLock
interface CalendarStore {
    fun write(name: String, json: JSONObject)
    fun read(name: String): JSONObject?
    fun delete(name: String)
    fun renewCookie(expected: String, replacement: String, expiresAt: Long?, serverNow: Long?)
    fun anchor(auth: JSONObject, serverNow: Long)
    fun trustedNow(auth: JSONObject): Long
}

/** Protected records never live in cacheDir, which Android may remove. */
class CalendarStorage(private val context: Context) : CalendarStore {
    private val directory = File(context.noBackupFilesDir, "calendar").apply { mkdirs() }
    private val reserve = File(directory, "critical-reserve.bin")
    init { ensureReserve() }
    private fun ensureReserve() {
        if (reserve.length() >= 16L * 1024 * 1024 || directory.usableSpace < 96L * 1024 * 1024) return
        runCatching { RandomAccessFile(reserve, "rw").use { Os.posix_fallocate(it.fd, 0, 16L * 1024 * 1024) } }
    }
    @Synchronized override fun write(name: String, json: JSONObject) {
        val plain = json.toString().toByteArray(Charsets.UTF_8)
        val dataFile = name == "cache" || name == "local-cache"
        val allowance = if (dataFile) json.optInt("budgetMiB", 100).toLong() * 1024 * 1024 else 8L * 1024 * 1024
        val other = if (dataFile) File(directory, "${if (name == "cache") "local-cache" else "cache"}.bin").length() else 0
        check(plain.size.toLong() + other <= allowance) { "端末内の予定と取得済みデータが保存上限に達しました。設定から上限を増やしてください。" }
        val critical = name in setOf("reminders", "auth", "mode", "local-profile")
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
    @Synchronized override fun read(name: String): JSONObject? {
        val target = AtomicFile(File(directory, "$name.bin"))
        if (!target.baseFile.exists()) return null
        val bytes = target.openRead().use { it.readBytes() }
        check(bytes.size > 29 && bytes[0] == 1.toByte()) { "保存データを確認できません。" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(name.toByteArray())
        return JSONObject(cipher.doFinal(bytes.copyOfRange(13, bytes.size)).toString(Charsets.UTF_8))
    }
    @Synchronized override fun delete(name: String) { AtomicFile(File(directory, "$name.bin")).delete() }
    @Synchronized override fun renewCookie(expected: String, replacement: String, expiresAt: Long?, serverNow: Long?) {
        val auth = read("auth") ?: return
        if (auth.optString("cookie") != expected) return
        auth.put("cookie", replacement)
        if (expiresAt != null) auth.put("expiresAt", expiresAt)
        if (serverNow != null) anchor(auth, serverNow)
        write("auth", auth)
    }
    override fun anchor(auth: JSONObject, serverNow: Long) {
        auth.put("serverNow", serverNow).put("wallAtSync", System.currentTimeMillis()).put("elapsedAtSync", SystemClock.elapsedRealtime())
    }
    override fun trustedNow(auth: JSONObject): Long {
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
