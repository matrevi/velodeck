package com.velodeck.agent.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.velodeck.agent.storage.AgentConfigStore

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        Log.i(TAG, "Received system broadcast: $action")
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            try {
                PersistenceGuard.ensureAccessibilityEnabledIfPermitted(context)
                val config = AgentConfigStore.getInstance(context).current
                if (config.autoStart) {
                    AgentForegroundService.start(context)
                    WatchdogWorker.schedule(context)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Could not start agent service on $action", t)
            }
        }
    }

    companion object {
        private const val TAG = "BootReceiver"
    }
}
