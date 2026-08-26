package jp.tanaka.troom.ai.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import jp.tanaka.troom.ai.model.ConversationMode
import jp.tanaka.troom.ai.model.PendingMessage
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AI session and the single unsynchronised outgoing message are encrypted at rest. */
class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized fun saveSessionCookie(cookie: String) = save(KEY_COOKIE, cookie)
    @Synchronized fun readSessionCookie(): String? = read(KEY_COOKIE)
    @Synchronized fun clearSession() = preferences.edit().remove(KEY_COOKIE).apply()

    @Synchronized
    fun savePending(message: PendingMessage) = save(KEY_PENDING, JSONObject()
        .put("conversationId", message.conversationId)
        .put("clientRequestId", message.clientRequestId)
        .put("content", message.content)
        .put("mode", message.mode.wireValue).toString())

    @Synchronized
    fun readPending(): PendingMessage? = read(KEY_PENDING)?.let { raw ->
        runCatching {
            val value = JSONObject(raw)
            PendingMessage(
                value.getString("conversationId"),
                value.getString("clientRequestId"),
                value.getString("content"),
                if (value.optString("mode") == "voice") ConversationMode.VOICE else ConversationMode.CHAT,
            )
        }.getOrNull()
    }

    @Synchronized fun clearPending() = preferences.edit().remove(KEY_PENDING).apply()

    private fun save(name: String, value: String) {
        preferences.edit().putString(name, encrypt(value.toByteArray(Charsets.UTF_8))).apply()
    }

    private fun read(name: String): String? = preferences.getString(name, null)
        ?.let(::decrypt)?.toString(Charsets.UTF_8)

    private fun encrypt(plain: ByteArray): String {
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        return listOf(cipher.iv, cipher.doFinal(plain)).joinToString(".") {
            Base64.encodeToString(it, Base64.NO_WRAP or Base64.URL_SAFE)
        }
    }

    private fun decrypt(value: String): ByteArray? = runCatching {
        val (encodedIv, encodedCiphertext) = value.split('.', limit = 2)
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP or Base64.URL_SAFE)),
        )
        cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP or Base64.URL_SAFE))
    }.getOrNull()

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    private companion object {
        const val PREFERENCES = "troom_ai_secure_storage"
        const val KEY_COOKIE = "ai_session_cookie"
        const val KEY_PENDING = "pending_message"
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "troom_ai_session_storage_v1"
        const val CIPHER = "AES/GCM/NoPadding"
    }
}
