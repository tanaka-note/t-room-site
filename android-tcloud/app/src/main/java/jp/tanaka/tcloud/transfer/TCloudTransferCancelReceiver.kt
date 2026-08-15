package jp.tanaka.tcloud.transfer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import jp.tanaka.tcloud.TCloudApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class TCloudTransferCancelReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val batchId = intent.getStringExtra(EXTRA_BATCH_ID).orEmpty()
        if (batchId.isBlank()) return
        val pending = goAsync()
        val application = context.applicationContext as TCloudApplication
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                application.transferCancellation.cancel(batchId)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_CANCEL = "jp.tanaka.tcloud.action.CANCEL_TRANSFER"
        const val EXTRA_BATCH_ID = "batch_id"
    }
}
