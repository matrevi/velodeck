package com.velodeck.agent.service

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.velodeck.agent.input.VeloDeckAccessibilityService

/**
 * Long-lived 7x24 persistence & self-healing guard for unattended Android operation.
 *
 * Capabilities:
 * 1. If the user has granted `WRITE_SECURE_SETTINGS` once via ADB / Wireless ADB:
 *    automatically re-enables [VeloDeckAccessibilityService] in `Settings.Secure`
 *    whenever the ROM disables it after an app update, process kill, or reboot.
 * 2. Schedules an exact/allow-while-idle [AlarmManager] revival if the user swipes the
 *    app away from Recents (`onTaskRemoved`), complementing [WatchdogWorker] and
 *    [VeloDeckAccessibilityService]'s system-bound mutual watchdog.
 */
object PersistenceGuard {

    private const val TAG = "PersistenceGuard"
    private const val REQ_CODE_RESTART_ALARM = 4091

    fun hasWriteSecureSettings(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context.applicationContext,
            Manifest.permission.WRITE_SECURE_SETTINGS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Self-heals [VeloDeckAccessibilityService] whenever `WRITE_SECURE_SETTINGS` is granted.
     * Preserves all other enabled accessibility services on the device.
     * Returns true if our accessibility service is now enabled (or was already enabled).
     */
    fun ensureAccessibilityEnabledIfPermitted(context: Context): Boolean {
        val appCtx = context.applicationContext
        if (VeloDeckAccessibilityService.connectedFlow.value) {
            return true
        }
        if (!hasWriteSecureSettings(appCtx)) {
            return false
        }
        return try {
            val resolver = appCtx.contentResolver
            val targetShort = ComponentName(
                appCtx.packageName,
                VeloDeckAccessibilityService::class.java.name,
            ).flattenToShortString()
            val targetFull = ComponentName(
                appCtx.packageName,
                VeloDeckAccessibilityService::class.java.name,
            ).flattenToString()

            val currentRaw = Settings.Secure.getString(
                resolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ).orEmpty().trim()

            val existingEntries = currentRaw
                .split(':')
                .map { it.trim() }
                .filter { it.isNotEmpty() && !it.equals("null", ignoreCase = true) }

            val alreadyListed = existingEntries.any {
                it.equals(targetShort, ignoreCase = true) ||
                    it.equals(targetFull, ignoreCase = true)
            }

            if (!alreadyListed) {
                val updated = (existingEntries + targetFull).joinToString(":")
                Settings.Secure.putString(
                    resolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
                    updated,
                )
            }
            Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            Log.i(TAG, "Self-healed VeloDeckAccessibilityService via WRITE_SECURE_SETTINGS")
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to self-heal accessibility service", t)
            false
        }
    }

    /**
     * Schedules a resilient service restart via [AlarmManager] when the task is swiped away
     * from Recents, so the background agent returns within ~1.5s without waiting for WorkManager.
     */
    fun scheduleServiceRestart(context: Context, delayMs: Long = 1_500L) {
        val appCtx = context.applicationContext
        val intent = Intent(appCtx, AgentForegroundService::class.java).apply {
            action = AgentForegroundService.ACTION_START
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(appCtx, REQ_CODE_RESTART_ALARM, intent, piFlags)
        } else {
            PendingIntent.getService(appCtx, REQ_CODE_RESTART_ALARM, intent, piFlags)
        }
        val alarmManager = appCtx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val triggerAt = SystemClock.elapsedRealtime() + delayMs.coerceIn(500L, 60_000L)
        try {
            alarmManager.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAt,
                pi,
            )
            Log.i(TAG, "Scheduled foreground service revival in ${delayMs}ms")
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to schedule AlarmManager revival", t)
        }
    }
}
