package com.velodeck.agent.service

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.velodeck.agent.storage.AgentConfigStore
import java.util.concurrent.TimeUnit

/**
 * 15-minute periodic WorkManager watchdog that ensures [AgentForegroundService]
 * stays alive 7x24 even if the OS kills the background process under memory pressure.
 */
class WatchdogWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val cfg = AgentConfigStore.getInstance(applicationContext).current
        if (!cfg.autoStart) {
            return Result.success()
        }
        PersistenceGuard.ensureAccessibilityEnabledIfPermitted(applicationContext)
        if (!AgentForegroundService.isRunning.value) {
            Log.w(TAG, "AgentForegroundService was not running; restarting from watchdog")
            try {
                AgentForegroundService.start(applicationContext)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to restart AgentForegroundService from watchdog", t)
                return Result.retry()
            }
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "WatchdogWorker"
        private const val UNIQUE_WORK_NAME = "velodeck_watchdog"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<WatchdogWorker>(15, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                UNIQUE_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(UNIQUE_WORK_NAME)
        }
    }
}
