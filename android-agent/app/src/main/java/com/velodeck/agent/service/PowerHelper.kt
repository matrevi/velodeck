package com.velodeck.agent.service

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.util.Log
import com.velodeck.agent.input.VeloDeckAccessibilityService

data class BatterySnapshot(
    val levelPercent: Int,
    val charging: Boolean,
)

object PowerHelper {
    private const val TAG = "PowerHelper"

    @Suppress("DEPRECATION")
    fun wakeScreen(context: Context): Boolean {
        return try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                    PowerManager.ACQUIRE_CAUSES_WAKEUP or
                    PowerManager.ON_AFTER_RELEASE,
                "VeloDeck:RemoteWake",
            )
            wl.setReferenceCounted(false)
            wl.acquire(3_000L)

            val a11yContext = VeloDeckAccessibilityService.instance
            val launchContext: Context = a11yContext ?: context
            val intent = Intent(launchContext, WakeActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS,
                )
            }
            try {
                launchContext.startActivity(intent)
            } catch (t: Throwable) {
                if (a11yContext != null && a11yContext !== context) {
                    context.startActivity(intent)
                } else {
                    throw t
                }
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to wake screen", t)
            false
        }
    }

    fun isScreenOn(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isInteractive
    }

    fun isDeviceLocked(context: Context): Boolean {
        val km = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return km.isKeyguardLocked || km.isDeviceLocked
    }

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun getBatterySnapshot(context: Context): BatterySnapshot {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryIntent = context.registerReceiver(null, filter)
        if (batteryIntent != null) {
            val level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            val pct = if (level >= 0 && scale > 0) ((level * 100f) / scale).toInt().coerceIn(0, 100) else 100
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
            return BatterySnapshot(pct, charging)
        }
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val cap = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.coerceIn(0, 100) ?: 100
        val charging = bm?.isCharging ?: false
        return BatterySnapshot(cap, charging)
    }
}
