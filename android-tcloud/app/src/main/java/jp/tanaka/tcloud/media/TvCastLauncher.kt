package jp.tanaka.tcloud.media

import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * Opens Android's protected screen-cast selector. T-Cloud continues decrypting only on the phone;
 * no decrypted media URL or folder key is uploaded to Cloudflare or handed to a Cast receiver.
 */
object TvCastLauncher {
    fun launch(context: Context): Boolean {
        val intent = Intent(Settings.ACTION_CAST_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(context.packageManager) == null) return false
        context.startActivity(intent)
        return true
    }
}
