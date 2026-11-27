package com.velodeck.agent.service

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.lang.ref.WeakReference

/**
 * Pure pitch-black (#000000) fallback OLED curtain Activity used when Accessibility overlay
 * is not enabled. Keeps CPU & screen awake at hardware minimum brightness while appearing
 * completely turned off; pressing the Power/Lock key (handled in [AgentForegroundService])
 * or triple-pressing Volume Down immediately dismisses it.
 */
class BlackScreenActivity : AppCompatActivity() {

    private var volDownTapCount = 0
    private var lastVolDownElapsedMs = 0L

    @Volatile
    private var dismissedProgrammatically = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val lp = window.attributes
        lp.screenBrightness = 0.004f
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        window.attributes = lp

        val blackView = View(this).apply {
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
        }
        setContentView(blackView)

        WindowInsetsControllerCompat(window, blackView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        activeRef = WeakReference(this)
        if (AgentForegroundService.runtimeState.value.activeSessions > 0) {
            dismissedProgrammatically = true
            finishSafely()
        }
    }

    override fun onResume() {
        super.onResume()
        if (AgentForegroundService.runtimeState.value.activeSessions > 0) {
            dismissedProgrammatically = true
            finishSafely()
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastVolDownElapsedMs < 1_200L) {
                volDownTapCount += 1
            } else {
                volDownTapCount = 1
            }
            lastVolDownElapsedMs = now
            if (volDownTapCount >= 3) {
                dismissedProgrammatically = true
                AgentForegroundService.exitBlackScreen(this)
                finishSafely()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        if (activeRef?.get() === this) {
            activeRef = null
        }
        val state = AgentForegroundService.runtimeState.value
        if (!dismissedProgrammatically &&
            !isChangingConfigurations &&
            state.blackScreenActive &&
            state.activeSessions == 0
        ) {
            AgentForegroundService.exitBlackScreen(applicationContext)
        }
        super.onDestroy()
    }

    private fun finishSafely() {
        if (!isFinishing && !isDestroyed) {
            finish()
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    companion object {
        @Volatile
        private var activeRef: WeakReference<BlackScreenActivity>? = null

        fun launch(context: Context) {
            val intent = Intent(context, BlackScreenActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION,
                )
            }
            context.startActivity(intent)
        }

        fun dismissIfActive() {
            activeRef?.get()?.let { act ->
                act.dismissedProgrammatically = true
                act.runOnUiThread { act.finishSafely() }
            }
        }
    }
}
