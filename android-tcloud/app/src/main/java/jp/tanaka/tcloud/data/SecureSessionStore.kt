package jp.tanaka.tcloud.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun saveSessionCookie(cookie: String) {
        preferences.edit().putString(KEY_COOKIE, encrypt(cookie.toByteArray(Charsets.UTF_8))).apply()
    }

    @Synchronized
    fun readSessionCookie(): String? = preferences.getString(KEY_COOKIE, null)
        ?.let(::decrypt)
        ?.toString(Charsets.UTF_8)

    @Synchronized
    fun saveAccountKey(accountKey: ByteArray) {
        preferences.edit().putString(KEY_ACCOUNT_KEY, encrypt(accountKey)).apply()
    }

    @Synchronized
    fun readAccountKey(): ByteArray? = preferences.getString(KEY_ACCOUNT_KEY, null)?.let(::decrypt)

    @Synchronized
    fun clearAccountKey() {
        preferences.edit().remove(KEY_ACCOUNT_KEY).apply()
    }

    @Synchronized
    fun saveFolderKey(folderId: Long, folderKey: ByteArray, expiresAtEpochSeconds: Long) {
        preferences.edit()
            .putString(folderKeyName(folderId), encrypt(folderKey))
            .putLong(folderExpiryName(folderId), expiresAtEpochSeconds)
            .apply()
    }

    @Synchronized
    fun readFolderKey(folderId: Long, nowEpochSeconds: Long = System.currentTimeMillis() / 1000): ByteArray? {
        val expiresAt = preferences.getLong(folderExpiryName(folderId), 0)
        if (expiresAt <= nowEpochSeconds) {
            removeFolderKey(folderId)
            return null
        }
        return preferences.getString(folderKeyName(folderId), null)?.let(::decrypt)
    }

    @Synchronized
    fun removeFolderKey(folderId: Long) {
        preferences.edit()
            .remove(folderKeyName(folderId))
            .remove(folderExpiryName(folderId))
            .apply()
    }

    @Synchronized
    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun encrypt(plain: ByteArray): String {
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(plain)
        return listOf(cipher.iv, encrypted)
            .joinToString(".") { Base64.encodeToString(it, Base64.NO_WRAP or Base64.URL_SAFE) }
    }

    private fun decrypt(value: String): ByteArray? = runCatching {
        val (encodedIv, encodedCiphertext) = value.split('.', limit = 2)
        val iv = Base64.decode(encodedIv, Base64.NO_WRAP or Base64.URL_SAFE)
        val ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP or Base64.URL_SAFE)
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        cipher.doFinal(ciphertext)
    }.getOrNull()

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private fun folderKeyName(folderId: Long) = "$KEY_FOLDER_PREFIX$folderId"

    private fun folderExpiryName(folderId: Long) = "$KEY_FOLDER_EXPIRY_PREFIX$folderId"

    private companion object {
        const val PREFERENCES = "tcloud_secure_session"
        const val KEY_COOKIE = "session_cookie"
        const val KEY_ACCOUNT_KEY = "account_key"
        const val KEY_FOLDER_PREFIX = "folder_key_"
        const val KEY_FOLDER_EXPIRY_PREFIX = "folder_key_expiry_"
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "tcloud_session_storage_v1"
        const val CIPHER = "AES/GCM/NoPadding"
    }
}
