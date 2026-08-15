package jp.tanaka.tcloud.transfer

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

internal fun isTransferNetworkAvailable(context: Context, requireUnmetered: Boolean = false): Boolean {
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val network = manager.activeNetwork ?: return false
    val capabilities = manager.getNetworkCapabilities(network) ?: return false
    return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
        (!requireUnmetered || capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
}
