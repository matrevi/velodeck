package com.velodeck.agent.service

import android.app.KeyguardManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity

/**
 * Transparent 1x1 activity invoked on remote `wake` commands to turn the screen on
 * and optionally dismiss an insecure swipe keyguard.
 */
class WakeActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val km = getSystemService(KEYGUARD_SERVICE) as? KeyguardManager
        if (km != null && km.isKeyguardLocked && !km.isDeviceSecure) {
            km.requestDismissKeyguard(this, null)
        }

        handler.postDelayed({ finishSafely() }, 350L)
    }

    private fun finishSafely() {
        if (!isFinishing && !isDestroyed) {
            finish()
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
