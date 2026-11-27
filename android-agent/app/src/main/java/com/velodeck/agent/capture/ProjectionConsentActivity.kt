package com.velodeck.agent.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.velodeck.agent.input.VeloDeckAccessibilityService
import com.velodeck.agent.service.AgentForegroundService
import com.velodeck.agent.storage.AgentConfigStore

/**
 * Transparent helper Activity that requests persistent MediaProjection consent once
 * and hands the result token over to [AgentForegroundService] so it stays alive
 * across idle periods and multiple remote sessions without re-prompting.
 */
class ProjectionConsentActivity : AppCompatActivity() {

    private var awaitingSystemDialog: Boolean = false

    private val projectionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        awaitingSystemDialog = false
        VeloDeckAccessibilityService.disarmAutoAcceptProjection()
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            Log.i(TAG, "MediaProjection consent granted")
            AgentForegroundService.deliverProjectionConsent(
                context = this,
                resultCode = result.resultCode,
                data = data,
            )
            setResult(Activity.RESULT_OK)
        } else {
            Log.w(TAG, "MediaProjection consent denied or cancelled (resultCode=${result.resultCode})")
            setResult(Activity.RESULT_CANCELED)
        }
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = AgentConfigStore.getInstance(this).current
        if (config.autoAcceptProjection && VeloDeckAccessibilityService.connectedFlow.value) {
            VeloDeckAccessibilityService.armAutoAcceptProjection(timeoutMs = 4_000L)
        }

        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val captureIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            mpm.createScreenCaptureIntent()
        }

        try {
            awaitingSystemDialog = true
            projectionLauncher.launch(captureIntent)
        } catch (t: Throwable) {
            awaitingSystemDialog = false
            VeloDeckAccessibilityService.disarmAutoAcceptProjection()
            Log.e(TAG, "Failed to launch MediaProjection consent intent", t)
            finish()
        }
    }

    override fun onPause() {
        super.onPause()
        if (!awaitingSystemDialog || isFinishing) {
            VeloDeckAccessibilityService.disarmAutoAcceptProjection()
        }
    }

    override fun onStop() {
        super.onStop()
        if (!awaitingSystemDialog || isFinishing) {
            VeloDeckAccessibilityService.disarmAutoAcceptProjection()
        }
    }

    override fun onDestroy() {
        awaitingSystemDialog = false
        VeloDeckAccessibilityService.disarmAutoAcceptProjection()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ProjectionConsentAct"

        fun launch(context: Context) {
            val intent = Intent(context, ProjectionConsentActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            }
            context.startActivity(intent)
        }
    }
}
