package com.velodeck.agent.service

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

class NetworkMonitor(
    context: Context,
    private val onDefaultNetworkChanged: (networkChanged: Boolean) -> Unit,
) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val registered = AtomicBoolean(false)
    private val lock = Any()
    private var activeNetworkHandle: Long? = null

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val handle = network.networkHandle
            val switched = synchronized(lock) {
                val prev = activeNetworkHandle
                activeNetworkHandle = handle
                prev != handle
            }
            if (switched) {
                Log.i(TAG, "Default network available/switched (handle=$handle)")
                onDefaultNetworkChanged(true)
            }
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val isCurrentDefault = synchronized(lock) {
                activeNetworkHandle == null || activeNetworkHandle == network.networkHandle
            }
            if (isCurrentDefault) {
                // IP address, DHCP renewal, or VPN route changed without default network switch
                onDefaultNetworkChanged(false)
            }
        }

        override fun onLost(network: Network) {
            val handle = network.networkHandle
            val lostActive = synchronized(lock) {
                if (activeNetworkHandle == handle) {
                    activeNetworkHandle = null
                    true
                } else {
                    false
                }
            }
            if (lostActive) {
                Log.i(TAG, "Active default network lost (handle=$handle)")
                onDefaultNetworkChanged(true)
            }
        }
    }

    fun start() {
        if (!registered.compareAndSet(false, true)) return
        try {
            synchronized(lock) {
                activeNetworkHandle = runCatching { cm.activeNetwork?.networkHandle }.getOrNull()
            }
            cm.registerDefaultNetworkCallback(callback)
        } catch (t: Throwable) {
            registered.set(false)
            synchronized(lock) {
                activeNetworkHandle = null
            }
            Log.w(TAG, "Failed to register default NetworkCallback", t)
        }
    }

    fun stop() {
        if (!registered.compareAndSet(true, false)) return
        synchronized(lock) {
            activeNetworkHandle = null
        }
        try {
            cm.unregisterNetworkCallback(callback)
        } catch (_: Throwable) {
        }
    }

    companion object {
        private const val TAG = "NetworkMonitor"
    }
}
