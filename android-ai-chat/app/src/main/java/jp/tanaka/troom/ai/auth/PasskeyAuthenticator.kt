package jp.tanaka.troom.ai.auth

import android.app.Activity
import androidx.credentials.GetCredentialRequest
import androidx.credentials.CredentialManager
import androidx.credentials.PublicKeyCredential
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException

class PasskeyAuthenticator {
    suspend fun authenticate(activity: Activity, requestJson: String): String {
        val manager = CredentialManager.create(activity)
        return try {
            val result = manager.getCredential(
                context = activity,
                request = GetCredentialRequest(
                    credentialOptions = listOf(GetPublicKeyCredentialOption(requestJson = requestJson)),
                ),
            )
            val credential = result.credential as? PublicKeyCredential
                ?: throw PasskeyException("この端末でパスキーの応答を確認できませんでした。")
            credential.authenticationResponseJson
        } catch (_: GetCredentialCancellationException) {
            throw PasskeyException("端末のロック解除がキャンセルされたか、操作の有効期限が切れました。もう一度お試しください。")
        } catch (error: GetCredentialException) {
            throw PasskeyException("端末でパスキー認証を完了できませんでした。画面ロックと通信状態を確認してください。", error)
        }
    }
}

class PasskeyException(message: String, cause: Throwable? = null) : Exception(message, cause)
