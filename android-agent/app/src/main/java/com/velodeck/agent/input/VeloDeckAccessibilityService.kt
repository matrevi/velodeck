package com.velodeck.agent.input

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.velodeck.agent.protocol.ControlCommand
import com.velodeck.agent.protocol.RemoteKey
import com.velodeck.agent.service.AgentForegroundService
import com.velodeck.agent.service.PowerHelper
import com.velodeck.agent.storage.AgentConfigStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.hypot
import kotlin.math.min

class VeloDeckAccessibilityService : AccessibilityService() {

    private data class LiveStrokeState(
        val pointerId: Int,
        var stroke: GestureDescription.StrokeDescription,
        var lastX: Float,
        var lastY: Float,
        var lastTs: Long,
    )

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val liveTouchMutex = Mutex()
    private var liveStroke: LiveStrokeState? = null
    private var liveStrokeReleaseJob: Job? = null
    private val spinnerExpanded = AtomicBoolean(false)
    private val lastAutoClickMs = AtomicLong(0L)
    private val clipboardOpSeq = AtomicLong(0L)
    private var blackCurtainView: View? = null
    private var blackCurtainTapCount = 0
    private var blackCurtainLastTapMs = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        _connectedFlow.value = true
        Log.i(TAG, "VeloDeckAccessibilityService connected")
        // Mutual 7x24 watchdog: AccessibilityService is kept bound by system_server;
        // if AgentForegroundService was killed by the ROM, revive it immediately.
        try {
            val cfg = AgentConfigStore.getInstance(this).current
            if (cfg.autoStart && !AgentForegroundService.isRunning.value) {
                Log.i(TAG, "Reviving AgentForegroundService from AccessibilityService")
                AgentForegroundService.start(this)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Could not revive AgentForegroundService onServiceConnected", t)
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "VeloDeckAccessibilityService interrupted")
    }

    override fun onDestroy() {
        hideBlackCurtain()
        liveStrokeReleaseJob?.cancel()
        liveStrokeReleaseJob = null
        liveStroke = null
        serviceScope.cancel()
        if (instance === this) {
            instance = null
        }
        _connectedFlow.value = false
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    enum class DisplayOverlayMode {
        OFF,
        KEEP_AWAKE_ONLY,
        STEALTH_DIM,
        PURE_BLACK_IDLE,
    }

    /**
     * Displays a zero-extra-permission `TYPE_ACCESSIBILITY_OVERLAY` window for keep-awake,
     * stealth minimum-backlight remote viewing, or pure #000000 OLED idle disguise:
     * - [DisplayOverlayMode.OFF]: removes overlay completely.
     * - [DisplayOverlayMode.KEEP_AWAKE_ONLY]: 1x1 transparent touch-passthrough keep-screen-on
     *   layer at normal system brightness so remote sessions never auto-sleep into black frames.
     * - [DisplayOverlayMode.STEALTH_DIM]: 1x1 transparent touch-passthrough + 0.1% hardware minimum
     *   backlight + KEEP_SCREEN_ON so remote MediaProjection captures 100% full-brightness frames
     *   while the physical display stays ultra-dim and awake without a full-screen SurfaceFlinger layer.
     * - [DisplayOverlayMode.PURE_BLACK_IDLE]: pure #000000 OLED curtain + 0.1% backlight +
     *   KEEP_SCREEN_ON when idle (0 active remote sessions), with 5-tap emergency dismiss.
     */
    fun updateDisplayOverlay(
        mode: DisplayOverlayMode,
        onEmergencyDismiss: (() -> Unit)? = null,
    ): Boolean {
        if (mode == DisplayOverlayMode.OFF) {
            hideBlackCurtain()
            return true
        }
        val runUpdate: () -> Boolean = {
            try {
                val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val baseFlags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                val touchPassthrough = mode != DisplayOverlayMode.PURE_BLACK_IDLE
                val flags = if (touchPassthrough) {
                    baseFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                } else {
                    baseFlags
                }
                val size = overlayDimensionForMode(mode)
                val lp = WindowManager.LayoutParams(
                    size,
                    size,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    flags,
                    PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP or Gravity.START
                    screenBrightness = when (mode) {
                        DisplayOverlayMode.KEEP_AWAKE_ONLY -> WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                        DisplayOverlayMode.STEALTH_DIM -> 0.001f
                        DisplayOverlayMode.PURE_BLACK_IDLE -> 0.001f
                        DisplayOverlayMode.OFF -> WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        layoutInDisplayCutoutMode =
                            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    }
                }

                val bgColor = if (mode == DisplayOverlayMode.PURE_BLACK_IDLE) {
                    Color.BLACK
                } else {
                    Color.TRANSPARENT
                }
                val existing = blackCurtainView
                if (existing != null && existing.isAttachedToWindow) {
                    existing.setBackgroundColor(bgColor)
                    existing.invalidate()
                    wm.updateViewLayout(existing, lp)
                } else {
                    val v = View(this).apply {
                        setBackgroundColor(bgColor)
                        keepScreenOn = true
                        setOnClickListener {
                            val now = SystemClock.elapsedRealtime()
                            if (now - blackCurtainLastTapMs < 1_500L) {
                                blackCurtainTapCount += 1
                            } else {
                                blackCurtainTapCount = 1
                            }
                            blackCurtainLastTapMs = now
                            if (blackCurtainTapCount >= 5) {
                                blackCurtainTapCount = 0
                                onEmergencyDismiss?.invoke()
                            }
                        }
                    }
                    wm.addView(v, lp)
                    blackCurtainView = v
                }
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to update accessibility display overlay (mode=$mode)", t)
                false
            }
        }
        return if (Looper.myLooper() == Looper.getMainLooper()) {
            runUpdate()
        } else {
            mainHandler.post { runUpdate() }
            true
        }
    }

    fun showBlackCurtain(stealthDimOnly: Boolean, onEmergencyDismiss: (() -> Unit)? = null): Boolean {
        val mode = if (stealthDimOnly) DisplayOverlayMode.STEALTH_DIM else DisplayOverlayMode.PURE_BLACK_IDLE
        return updateDisplayOverlay(mode, onEmergencyDismiss)
    }

    fun hideBlackCurtain() {
        val runRemove = {
            val view = blackCurtainView
            blackCurtainView = null
            blackCurtainTapCount = 0
            if (view != null) {
                try {
                    val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
                    if (view.isAttachedToWindow) {
                        wm.removeViewImmediate(view)
                    }
                } catch (_: Throwable) {
                }
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runRemove()
        } else {
            mainHandler.post(runRemove)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val now = SystemClock.elapsedRealtime()
        if (now >= autoAcceptUntilElapsedMs.get()) return

        // Strict package guardrail: ONLY allow SystemUI MediaProjection consent dialogs
        val pkg = event.packageName?.toString().orEmpty()
        if (pkg != SYSTEM_UI_PACKAGE) {
            return
        }

        // Throttle inspection to avoid rapid duplicate clicks
        if (now - lastAutoClickMs.get() < 220L) return
        tryAutoAcceptCurrentSystemUi(now)
    }

    private fun tryAutoAcceptCurrentSystemUi(now: Long = SystemClock.elapsedRealtime()) {
        if (now >= autoAcceptUntilElapsedMs.get()) return
        if (now - lastAutoClickMs.get() < 220L) return

        val roots = collectSystemUiRoots()
        if (roots.isEmpty()) return

        try {
            handleProjectionConsentDialog(roots, now)
        } catch (t: Throwable) {
            Log.w(TAG, "Auto-accept projection dialog attempt failed", t)
        } finally {
            roots.forEach { safeRecycle(it) }
        }
    }

    private fun startAutoAcceptPollLoop() {
        val poll = object : Runnable {
            override fun run() {
                val now = SystemClock.elapsedRealtime()
                if (now >= autoAcceptUntilElapsedMs.get()) return
                tryAutoAcceptCurrentSystemUi(now)
                if (SystemClock.elapsedRealtime() < autoAcceptUntilElapsedMs.get()) {
                    mainHandler.postDelayed(this, 220L)
                }
            }
        }
        mainHandler.postDelayed(poll, 180L)
    }

    private fun handleProjectionConsentDialog(roots: List<AccessibilityNodeInfo>, now: Long) {
        // Strict dialog-tree verification: require BOTH a screen recording/casting phrase
        // AND our own app identifier ("VeloDeck" / "极控" / "com.velodeck.agent") before clicking anything!
        val windowTexts = collectAllNodeTexts(roots)
        if (!isVeloDeckProjectionDialog(windowTexts)) {
            return
        }

        // Step 1 (Android 14+): if "Entire screen / 整个屏幕" dropdown option is currently visible in popup list, click it
        val entireOption = findNode(roots) { node ->
            val txt = node.text?.toString()?.trim().orEmpty()
            txt.equals("Entire screen", ignoreCase = true) ||
                txt.equals("A whole screen", ignoreCase = true) ||
                txt.contains("entire screen", ignoreCase = true) ||
                txt.contains("整个屏幕") ||
                txt.contains("整个设备屏幕") ||
                txt.contains("全屏")
        }
        if (entireOption != null && entireOption.className?.toString()?.contains("Spinner") != true) {
            val isSpinnerChild = entireOption.parent?.className?.toString()?.contains("Spinner") == true
            if (!isSpinnerChild && clickNodeOrParent(entireOption)) {
                lastAutoClickMs.set(now)
                spinnerExpanded.set(false)
                Log.i(TAG, "Auto-selected 'Entire screen' option in MediaProjection dialog")
                return
            }
        }

        // If spinner currently shows "A single app / 单个应用", tap spinner to open options
        if (!spinnerExpanded.get()) {
            val singleAppSpinner = findNode(roots) { node ->
                val txt = node.text?.toString()?.trim().orEmpty()
                txt.contains("single app", ignoreCase = true) ||
                    txt.contains("单个应用") ||
                    txt.contains("单个软件")
            }
            if (singleAppSpinner != null && clickNodeOrParent(singleAppSpinner)) {
                spinnerExpanded.set(true)
                lastAutoClickMs.set(now)
                Log.i(TAG, "Opened Android 14+ MediaProjection mode spinner")
                return
            }
        }

        // Step 2: Click positive button ("Start now" / "立即开始" / "允许" / android:id/button1)
        val confirmButton = findNode(roots) { node ->
            val id = node.viewIdResourceName.orEmpty()
            val txt = node.text?.toString()?.trim().orEmpty()
            val isPositiveId = id == "android:id/button1" || id.endsWith(":id/button1")
            val isPositiveText = POSITIVE_PROJECTION_LABELS.any { label ->
                txt.equals(label, ignoreCase = true)
            }
            val isNegativeText = NEGATIVE_LABELS.any { label ->
                txt.equals(label, ignoreCase = true)
            }
            !isNegativeText && (isPositiveId || isPositiveText) && (node.isClickable || node.parent?.isClickable == true)
        }

        if (confirmButton != null && clickNodeOrParent(confirmButton)) {
            lastAutoClickMs.set(now)
            autoAcceptUntilElapsedMs.set(0L)
            spinnerExpanded.set(false)
            Log.i(TAG, "Auto-accepted MediaProjection consent dialog")
        }
    }

    suspend fun executeCommand(command: ControlCommand, configuredPin: String? = null): Pair<Boolean, String?> {
        return when (command) {
            is ControlCommand.Tap -> {
                val (w, h) = getScreenSize()
                val px = toPxX(command.x, w)
                val py = toPxY(command.y, h)
                val ok = dispatchGuardedStroke(px, py, px, py, TAP_DURATION_MS)
                ok to if (ok) null else "Tap gesture cancelled"
            }

            is ControlCommand.LongPress -> {
                val (w, h) = getScreenSize()
                val px = toPxX(command.x, w)
                val py = toPxY(command.y, h)
                val dur = (command.durationMs ?: 550L).coerceIn(100L, 5_000L)
                val ok = dispatchGuardedStroke(px, py, px, py, dur)
                ok to if (ok) null else "Long press gesture cancelled"
            }

            is ControlCommand.Swipe -> {
                val (w, h) = getScreenSize()
                val x1 = toPxX(command.x1, w)
                val y1 = toPxY(command.y1, h)
                val x2 = toPxX(command.x2, w)
                val y2 = toPxY(command.y2, h)
                val dur = (command.durationMs ?: 180L).coerceIn(40L, 2_000L)
                val ok = dispatchGuardedStroke(x1, y1, x2, y2, dur)
                ok to if (ok) null else "Swipe gesture cancelled"
            }

            is ControlCommand.TouchDown -> {
                val (w, h) = getScreenSize()
                val px = toPxX(command.x, w)
                val py = toPxY(command.y, h)
                val ok = handleLiveTouchDown(command.pointerId, px, py)
                ok to if (ok) null else "Live touch down failed"
            }

            is ControlCommand.TouchMove -> {
                val (w, h) = getScreenSize()
                val px = toPxX(command.x, w)
                val py = toPxY(command.y, h)
                val ok = handleLiveTouchMove(command.pointerId, px, py)
                ok to if (ok) null else "Live touch move failed"
            }

            is ControlCommand.TouchUp -> {
                val (w, h) = getScreenSize()
                val px = toPxX(command.x, w)
                val py = toPxY(command.y, h)
                val ok = handleLiveTouchUp(command.pointerId, px, py)
                ok to if (ok) null else "Live touch up failed"
            }

            is ControlCommand.Pinch -> {
                val ok = liveTouchMutex.withLock {
                    releaseLiveStrokeLocked()
                    dispatchPinch(command)
                }
                ok to if (ok) null else "Pinch gesture cancelled"
            }

            is ControlCommand.Key -> executeRemoteKey(command.key)

            is ControlCommand.Text -> executeTextInput(command.text, command.submit == true)

            is ControlCommand.ClipboardSet -> {
                clipboardOpSeq.incrementAndGet()
                val ok = setClipboardText(command.text, sensitive = false)
                ok to if (ok) null else "Failed to set clipboard"
            }

            is ControlCommand.Wake -> {
                val ok = PowerHelper.wakeScreen(this)
                ok to if (ok) null else "Failed to wake screen"
            }

            is ControlCommand.Unlock -> {
                val effectivePin = command.pin?.takeIf { it.isNotBlank() } ?: configuredPin?.takeIf { it.isNotBlank() }
                performUnlock(effectivePin)
            }

            is ControlCommand.BlackScreen,
            is ControlCommand.Quality,
            is ControlCommand.RequestKeyframe,
            -> true to null
        }
    }

    /** Safely finishes any currently held live touch stroke under [liveTouchMutex]. */
    suspend fun cancelActiveTouch() {
        liveTouchMutex.withLock {
            releaseLiveStrokeLocked()
        }
    }

    /** Non-blocking cleanup helper for non-suspend callers (e.g. teardown/shutdown hooks). */
    fun cancelActiveTouchAsync() {
        serviceScope.launch {
            cancelActiveTouch()
        }
    }

    private suspend fun dispatchGuardedStroke(
        x1: Float,
        y1: Float,
        x2: Float,
        y2: Float,
        durationMs: Long,
    ): Boolean {
        return liveTouchMutex.withLock {
            releaseLiveStrokeLocked()
            dispatchStroke(x1, y1, x2, y2, durationMs)
        }
    }

    private suspend fun handleLiveTouchDown(pointerId: Int, x: Float, y: Float): Boolean {
        return liveTouchMutex.withLock {
            // Release any stale unfinished stroke first
            releaseLiveStrokeLocked()
            val path = Path().apply { moveTo(x, y) }
            val stroke = GestureDescription.StrokeDescription(path, 0L, LIVE_TOUCH_HOLD_MS, true)
            val desc = GestureDescription.Builder().addStroke(stroke).build()
            val ok = dispatchGestureAwait(desc)
            if (ok) {
                val now = SystemClock.uptimeMillis()
                liveStroke = LiveStrokeState(pointerId, stroke, x, y, now)
                scheduleLiveStrokeSafetyReleaseLocked(pointerId, now)
            }
            ok
        }
    }

    private suspend fun handleLiveTouchMove(pointerId: Int, x: Float, y: Float): Boolean {
        return liveTouchMutex.withLock {
            val cur = liveStroke
            if (cur == null || cur.pointerId != pointerId) {
                return@withLock true
            }
            val dist = hypot((x - cur.lastX).toDouble(), (y - cur.lastY).toDouble())
            if (dist < 2.0) return@withLock true
            val now = SystemClock.uptimeMillis()
            val segDur = (now - cur.lastTs).coerceIn(LIVE_MOVE_MIN_DURATION_MS, LIVE_MOVE_MAX_DURATION_MS)
            val path = Path().apply {
                moveTo(cur.lastX, cur.lastY)
                lineTo(x, y)
            }
            val nextStroke = cur.stroke.continueStroke(path, 0L, segDur, true)
            val desc = GestureDescription.Builder().addStroke(nextStroke).build()
            val ok = dispatchGestureAwait(desc)
            if (ok) {
                cur.stroke = nextStroke
                cur.lastX = x
                cur.lastY = y
                cur.lastTs = now
                scheduleLiveStrokeSafetyReleaseLocked(pointerId, now)
            } else {
                cancelLiveStrokeSafetyReleaseLocked()
                liveStroke = null
            }
            ok
        }
    }

    private suspend fun handleLiveTouchUp(pointerId: Int, x: Float, y: Float): Boolean {
        return liveTouchMutex.withLock {
            cancelLiveStrokeSafetyReleaseLocked()
            val cur = liveStroke
            liveStroke = null
            if (cur == null || cur.pointerId != pointerId) {
                return@withLock true
            }
            val path = Path().apply {
                moveTo(cur.lastX, cur.lastY)
                if (hypot((x - cur.lastX).toDouble(), (y - cur.lastY).toDouble()) >= 1.5) {
                    lineTo(x, y)
                }
            }
            val endStroke = cur.stroke.continueStroke(path, 0L, LIVE_TOUCH_HOLD_MS, false)
            val desc = GestureDescription.Builder().addStroke(endStroke).build()
            dispatchGestureAwait(desc)
        }
    }

    private suspend fun releaseLiveStrokeLocked() {
        cancelLiveStrokeSafetyReleaseLocked()
        val cur = liveStroke ?: return
        liveStroke = null
        try {
            val path = Path().apply { moveTo(cur.lastX, cur.lastY) }
            val endStroke = cur.stroke.continueStroke(path, 0L, LIVE_TOUCH_HOLD_MS, false)
            dispatchGestureAwait(GestureDescription.Builder().addStroke(endStroke).build())
        } catch (_: Throwable) {
        }
    }

    private fun scheduleLiveStrokeSafetyReleaseLocked(pointerId: Int, expectedLastTs: Long) {
        cancelLiveStrokeSafetyReleaseLocked()
        liveStrokeReleaseJob = serviceScope.launch {
            delay(LIVE_STROKE_SAFETY_TIMEOUT_MS)
            liveTouchMutex.withLock {
                val cur = liveStroke
                if (cur != null && cur.pointerId == pointerId && cur.lastTs == expectedLastTs) {
                    // Clear reference before releaseLiveStrokeLocked so we do not self-cancel
                    liveStrokeReleaseJob = null
                    releaseLiveStrokeLocked()
                }
            }
        }
    }

    private fun cancelLiveStrokeSafetyReleaseLocked() {
        liveStrokeReleaseJob?.cancel()
        liveStrokeReleaseJob = null
    }

    private suspend fun dispatchStroke(
        x1: Float,
        y1: Float,
        x2: Float,
        y2: Float,
        durationMs: Long,
    ): Boolean {
        val path = Path().apply {
            moveTo(x1, y1)
            if (x1 != x2 || y1 != y2) {
                lineTo(x2, y2)
            }
        }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(10L, 10_000L))
        val desc = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGestureAwait(desc)
    }

    private suspend fun dispatchPinch(cmd: ControlCommand.Pinch): Boolean {
        val (w, h) = getScreenSize()
        val minDim = min(w, h).toDouble()
        val cx = cmd.cx.coerceIn(0.05, 0.95) * w
        val cy = cmd.cy.coerceIn(0.05, 0.95) * h

        // Project two fingers symmetrically along 45-degree diagonal
        val cos45 = 0.70710678
        val startHalf = (cmd.startDist.coerceIn(0.02, 0.95) * minDim) / 2.0
        val endHalf = (cmd.endDist.coerceIn(0.02, 0.95) * minDim) / 2.0

        val f1x1 = (cx - startHalf * cos45).toFloat().coerceIn(4f, (w - 4).toFloat())
        val f1y1 = (cy - startHalf * cos45).toFloat().coerceIn(4f, (h - 4).toFloat())
        val f1x2 = (cx - endHalf * cos45).toFloat().coerceIn(4f, (w - 4).toFloat())
        val f1y2 = (cy - endHalf * cos45).toFloat().coerceIn(4f, (h - 4).toFloat())

        val f2x1 = (cx + startHalf * cos45).toFloat().coerceIn(4f, (w - 4).toFloat())
        val f2y1 = (cy + startHalf * cos45).toFloat().coerceIn(4f, (h - 4).toFloat())
        val f2x2 = (cx + endHalf * cos45).toFloat().coerceIn(4f, (w - 4).toFloat())
        val f2y2 = (cy + endHalf * cos45).toFloat().coerceIn(4f, (h - 4).toFloat())

        val duration = (cmd.durationMs ?: 320L).coerceIn(80L, 4_000L)

        val path1 = Path().apply {
            moveTo(f1x1, f1y1)
            lineTo(f1x2, f1y2)
        }
        val path2 = Path().apply {
            moveTo(f2x1, f2y1)
            lineTo(f2x2, f2y2)
        }

        val desc = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path1, 0L, duration))
            .addStroke(GestureDescription.StrokeDescription(path2, 0L, duration))
            .build()
        return dispatchGestureAwait(desc)
    }

    private suspend fun dispatchGestureAwait(description: GestureDescription): Boolean {
        val result = CompletableDeferred<Boolean>()
        mainHandler.post {
            try {
                val dispatched = dispatchGesture(
                    description,
                    object : GestureResultCallback() {
                        override fun onCompleted(gestureDescription: GestureDescription?) {
                            result.complete(true)
                        }

                        override fun onCancelled(gestureDescription: GestureDescription?) {
                            result.complete(false)
                        }
                    },
                    mainHandler,
                )
                if (!dispatched) {
                    result.complete(false)
                }
            } catch (t: Throwable) {
                Log.w(TAG, "dispatchGesture threw exception", t)
                result.complete(false)
            }
        }
        return withTimeoutOrNull(6_000L) { result.await() } ?: false
    }

    private fun executeRemoteKey(key: RemoteKey): Pair<Boolean, String?> {
        return when (key) {
            RemoteKey.BACK -> performGlobalAction(GLOBAL_ACTION_BACK) to null
            RemoteKey.HOME -> performGlobalAction(GLOBAL_ACTION_HOME) to null
            RemoteKey.RECENTS -> performGlobalAction(GLOBAL_ACTION_RECENTS) to null
            RemoteKey.NOTIFICATIONS -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS) to null
            RemoteKey.QUICK_SETTINGS -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS) to null
            RemoteKey.POWER_DIALOG -> performGlobalAction(GLOBAL_ACTION_POWER_DIALOG) to null
            RemoteKey.LOCK -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN) to null
                } else {
                    false to "LOCK requires Android 9+"
                }
            }

            RemoteKey.SCREENSHOT -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT) to null
                } else {
                    false to "SCREENSHOT requires Android 9+"
                }
            }

            RemoteKey.VOLUME_UP -> {
                val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                am?.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    AudioManager.ADJUST_RAISE,
                    AudioManager.FLAG_SHOW_UI,
                )
                (am != null) to null
            }

            RemoteKey.VOLUME_DOWN -> {
                val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                am?.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    AudioManager.ADJUST_LOWER,
                    AudioManager.FLAG_SHOW_UI,
                )
                (am != null) to null
            }

            RemoteKey.ENTER -> executeEnterKey()
            RemoteKey.BACKSPACE -> executeBackspaceKey()
        }
    }

    private fun executeEnterKey(): Pair<Boolean, String?> {
        val node = findEditableNode() ?: return false to "No focused input field"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val ok = node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                if (ok) return true to null
            }
            val current = getEffectiveNodeText(node)
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "$current\n")
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) to null
        } finally {
            safeRecycle(node)
        }
    }

    private fun executeBackspaceKey(): Pair<Boolean, String?> {
        val node = findEditableNode() ?: return false to "No focused input field"
        return try {
            val current = getEffectiveNodeText(node)
            if (current.isEmpty()) return true to null
            val selStart = node.textSelectionStart
            val selEnd = node.textSelectionEnd
            val next = when {
                selStart >= 0 && selEnd > selStart && selEnd <= current.length ->
                    current.removeRange(selStart, selEnd)
                selStart > 0 && selStart <= current.length ->
                    current.removeRange(selStart - 1, selStart)
                else -> current.dropLast(1)
            }
            val args = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, next)
            }
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) to null
        } finally {
            safeRecycle(node)
        }
    }

    private fun executeTextInput(text: String, submit: Boolean): Pair<Boolean, String?> {
        val previousClip = snapshotClipboard()
        val opSeq = clipboardOpSeq.incrementAndGet()
        setClipboardText(text, sensitive = true)
        val node = findEditableNode()
        if (node == null) {
            return true to "Copied to clipboard (no focused editable field)"
        }
        return try {
            // Try direct ACTION_PASTE first so text inserts cleanly at the cursor without wiping existing content
            var inserted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            if (!inserted) {
                val current = getEffectiveNodeText(node)
                val combined = current + text
                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, combined)
                }
                inserted = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            }
            if (inserted && submit && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
            inserted to if (inserted) null else "Failed to inject text into input node"
        } finally {
            safeRecycle(node)
            // Restore previous clipboard or clear sensitive temporary text after 300ms
            scheduleClipboardRestoreOrClear(previousClip, opSeq, CLIPBOARD_CLEANUP_DELAY_MS)
        }
    }

    private fun buildClipData(label: String, text: String, sensitive: Boolean): ClipData {
        val clip = ClipData.newPlainText(label, text)
        if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            clip.description.extras = PersistableBundle().apply {
                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
        }
        return clip
    }

    private fun snapshotClipboard(): ClipData? {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return readPrimaryClipSafely()
        }
        val latch = CountDownLatch(1)
        val holder = AtomicReference<ClipData?>(null)
        mainHandler.post {
            try {
                holder.set(readPrimaryClipSafely())
            } finally {
                latch.countDown()
            }
        }
        return try {
            if (latch.await(250L, TimeUnit.MILLISECONDS)) holder.get() else null
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
    }

    private fun readPrimaryClipSafely(): ClipData? {
        return try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (cm.hasPrimaryClip()) cm.primaryClip else null
        } catch (_: Throwable) {
            null
        }
    }

    private fun scheduleClipboardRestoreOrClear(previousClip: ClipData?, expectedSeq: Long, delayMs: Long) {
        mainHandler.postDelayed({
            if (clipboardOpSeq.get() != expectedSeq) return@postDelayed
            try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                if (previousClip != null) {
                    cm.setPrimaryClip(previousClip)
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    cm.clearPrimaryClip()
                } else {
                    cm.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            } catch (t: Throwable) {
                Log.w(TAG, "Clipboard cleanup after paste failed", t)
            }
        }, delayMs)
    }

    private fun setClipboardText(text: String, sensitive: Boolean): Boolean {
        val clip = buildClipData("VeloDeck", text, sensitive)
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(clip)
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Clipboard set failed", t)
                false
            }
        }
        val latch = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        mainHandler.post {
            try {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(clip)
                ok.set(true)
            } catch (t: Throwable) {
                Log.w(TAG, "Clipboard set failed", t)
                ok.set(false)
            } finally {
                latch.countDown()
            }
        }
        return try {
            latch.await(500L, TimeUnit.MILLISECONDS) && ok.get()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    suspend fun performUnlock(pin: String?): Pair<Boolean, String> {
        PowerHelper.wakeScreen(this)
        delay(500L)

        if (!PowerHelper.isDeviceLocked(this)) {
            return true to "Screen awake and unlocked"
        }

        // Swipe upward to dismiss swipe lock or summon PIN keypad
        val (w, h) = getScreenSize()
        dispatchGuardedStroke(w * 0.5f, h * 0.85f, w * 0.5f, h * 0.22f, 280L)
        delay(500L)

        if (!PowerHelper.isDeviceLocked(this)) {
            return true to "Unlocked via upward swipe"
        }

        val digits = pin?.trim().orEmpty()
        if (digits.isEmpty()) {
            return false to "Device is PIN-locked; provide PIN in unlock command or configure Unlock PIN in Agent"
        }

        for (ch in digits) {
            if (!PowerHelper.isDeviceLocked(this)) break
            val clicked = tapKeypadDigit(ch)
            if (!clicked) {
                Log.w(TAG, "Could not locate lockscreen keypad node")
            }
            delay(150L)
        }

        delay(200L)
        if (PowerHelper.isDeviceLocked(this)) {
            tapKeypadConfirm()
            delay(450L)
        }

        val unlocked = !PowerHelper.isDeviceLocked(this)
        return unlocked to if (unlocked) "Device unlocked" else "Unlock attempt completed; device still reports locked"
    }

    private suspend fun tapKeypadDigit(digit: Char): Boolean {
        val digitStr = digit.toString()
        val roots = collectRoots()
        try {
            val target = findNode(roots) { node ->
                val id = node.viewIdResourceName?.lowercase().orEmpty()
                val text = node.text?.toString()?.trim().orEmpty()
                val desc = node.contentDescription?.toString()?.trim().orEmpty()
                val idMatch = id.endsWith("key$digitStr") ||
                    id.endsWith("key_$digitStr") ||
                    id.endsWith("digit_$digitStr") ||
                    id.endsWith("num_$digitStr") ||
                    id.endsWith("btn_$digitStr") ||
                    id.endsWith("pad_$digitStr")
                val textMatch = text == digitStr
                val descMatch = desc == digitStr ||
                    desc.startsWith("$digitStr,") ||
                    desc.startsWith("$digitStr ")
                idMatch || textMatch || descMatch
            } ?: return false

            if (clickNodeOrParent(target)) return true

            val rect = Rect()
            target.getBoundsInScreen(rect)
            if (!rect.isEmpty) {
                return dispatchGuardedStroke(
                    rect.exactCenterX(),
                    rect.exactCenterY(),
                    rect.exactCenterX(),
                    rect.exactCenterY(),
                    50L,
                )
            }
            return false
        } finally {
            roots.forEach { safeRecycle(it) }
        }
    }

    private suspend fun tapKeypadConfirm(): Boolean {
        val roots = collectRoots()
        try {
            val target = findNode(roots) { node ->
                val id = node.viewIdResourceName?.lowercase().orEmpty()
                val text = node.text?.toString()?.trim().orEmpty()
                val desc = node.contentDescription?.toString()?.trim().orEmpty()
                val idMatch = id.contains("key_enter") ||
                    id.endsWith("enter") ||
                    id.endsWith("ok") ||
                    id.endsWith("confirm") ||
                    id.endsWith("done")
                val labelMatch = CONFIRM_KEY_LABELS.any {
                    text.equals(it, ignoreCase = true) || desc.equals(it, ignoreCase = true)
                }
                idMatch || labelMatch
            } ?: return false

            if (clickNodeOrParent(target)) return true

            val rect = Rect()
            target.getBoundsInScreen(rect)
            if (!rect.isEmpty) {
                return dispatchGuardedStroke(
                    rect.exactCenterX(),
                    rect.exactCenterY(),
                    rect.exactCenterX(),
                    rect.exactCenterY(),
                    50L,
                )
            }
            return false
        } finally {
            roots.forEach { safeRecycle(it) }
        }
    }

    private fun findEditableNode(): AccessibilityNodeInfo? {
        val focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable) {
            return focused
        }
        if (focused != null) safeRecycle(focused)

        val roots = collectRoots()
        var fallbackEditable: AccessibilityNodeInfo? = null
        try {
            for (root in roots) {
                val foundFocused = findNode(listOf(root)) { it.isEditable && it.isFocused }
                if (foundFocused != null) return cloneNode(foundFocused)
                if (fallbackEditable == null) {
                    val anyEditable = findNode(listOf(root)) { it.isEditable }
                    if (anyEditable != null) fallbackEditable = cloneNode(anyEditable)
                }
            }
            return fallbackEditable
        } finally {
            roots.forEach { safeRecycle(it) }
        }
    }

    private fun cloneNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            AccessibilityNodeInfo(node)
        } else {
            @Suppress("DEPRECATION")
            AccessibilityNodeInfo.obtain(node)
        }
    }

    private fun getEffectiveNodeText(node: AccessibilityNodeInfo): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText) {
            return ""
        }
        return node.text?.toString().orEmpty()
    }

    private fun collectRoots(): List<AccessibilityNodeInfo> {
        val list = mutableListOf<AccessibilityNodeInfo>()
        try {
            windows?.forEach { win ->
                win.root?.let { list.add(it) }
            }
        } catch (_: Throwable) {
        }
        if (list.isEmpty()) {
            rootInActiveWindow?.let { list.add(it) }
        }
        return list
    }

    private fun collectSystemUiRoots(): List<AccessibilityNodeInfo> {
        val list = mutableListOf<AccessibilityNodeInfo>()
        try {
            windows?.forEach { win ->
                val root = win.root ?: return@forEach
                if (root.packageName?.toString() == SYSTEM_UI_PACKAGE) {
                    list.add(root)
                } else {
                    safeRecycle(root)
                }
            }
        } catch (_: Throwable) {
        }
        if (list.isEmpty()) {
            val active = rootInActiveWindow
            if (active != null) {
                if (active.packageName?.toString() == SYSTEM_UI_PACKAGE) {
                    list.add(active)
                } else {
                    safeRecycle(active)
                }
            }
        }
        return list
    }

    private fun collectAllNodeTexts(roots: List<AccessibilityNodeInfo>): List<String> {
        val texts = mutableListOf<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        roots.forEach { queue.addLast(it) }
        var visited = 0
        while (queue.isNotEmpty() && visited < 256) {
            val cur = queue.removeFirst()
            visited++
            cur.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { texts.add(it) }
            cur.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { texts.add(it) }
            val count = cur.childCount
            for (i in 0 until count) {
                val child = cur.getChild(i) ?: continue
                queue.addLast(child)
            }
        }
        return texts
    }

    private fun findNode(
        roots: List<AccessibilityNodeInfo>,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        roots.forEach { queue.addLast(it) }
        while (queue.isNotEmpty()) {
            val cur = queue.removeFirst()
            if (predicate(cur)) return cur
            val count = cur.childCount
            for (i in 0 until count) {
                val child = cur.getChild(i) ?: continue
                queue.addLast(child)
            }
        }
        return null
    }

    private fun clickNodeOrParent(node: AccessibilityNodeInfo): Boolean {
        var cur: AccessibilityNodeInfo? = node
        var depth = 0
        while (cur != null && depth < 4) {
            if (cur.isClickable) {
                return cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            cur = cur.parent
            depth++
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    private fun safeRecycle(node: AccessibilityNodeInfo?) {
        @Suppress("DEPRECATION")
        try {
            node?.recycle()
        } catch (_: Throwable) {
        }
    }

    fun getScreenSize(): Pair<Int, Int> {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = wm.maximumWindowMetrics.bounds
            bounds.width().coerceAtLeast(1) to bounds.height().coerceAtLeast(1)
        } else {
            val dm = DisplayMetrics()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(dm)
            dm.widthPixels.coerceAtLeast(1) to dm.heightPixels.coerceAtLeast(1)
        }
    }

    fun getDisplayRotation(): Int {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val rot = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            wm.defaultDisplay.rotation
        }
        return rot and 0x03
    }

    private fun toPxX(nx: Double, width: Int): Float =
        (nx.coerceIn(0.0, 1.0) * width).toFloat().coerceIn(1f, (width - 1).coerceAtLeast(1).toFloat())

    private fun toPxY(ny: Double, height: Int): Float =
        (ny.coerceIn(0.0, 1.0) * height).toFloat().coerceIn(1f, (height - 1).coerceAtLeast(1).toFloat())

    companion object {
        private const val TAG = "VeloDeckA11yService"
        private const val SYSTEM_UI_PACKAGE = "com.android.systemui"
        private const val CLIPBOARD_CLEANUP_DELAY_MS = 300L
        private const val TAP_DURATION_MS = 25L
        private const val LIVE_TOUCH_HOLD_MS = 10L
        private const val LIVE_MOVE_MIN_DURATION_MS = 12L
        private const val LIVE_MOVE_MAX_DURATION_MS = 24L
        private const val LIVE_STROKE_SAFETY_TIMEOUT_MS = 4_000L
        const val MAX_AUTO_ACCEPT_WINDOW_MS = 4_000L

        @Volatile
        var instance: VeloDeckAccessibilityService? = null
            private set

        private val _connectedFlow = MutableStateFlow(false)
        val connectedFlow: StateFlow<Boolean> = _connectedFlow.asStateFlow()

        private val autoAcceptUntilElapsedMs = AtomicLong(0L)

        private val PROJECTION_DIALOG_PHRASES = listOf(
            "recording",
            "casting",
            "录制",
            "投放",
            "投射",
            "投屏",
            "截屏",
        )

        private val APP_IDENTIFIERS = listOf(
            "velodeck",
            "极控",
            "com.velodeck.agent",
        )

        private val POSITIVE_PROJECTION_LABELS = listOf(
            "Start now",
            "Start recording",
            "Start casting",
            "Allow",
            "Start",
            "立即开始",
            "开始录制",
            "开始投屏",
            "允许",
            "开始",
        )

        private val NEGATIVE_LABELS = listOf(
            "Cancel",
            "Deny",
            "取消",
            "拒绝",
            "不允许",
        )

        private val CONFIRM_KEY_LABELS = listOf(
            "Enter",
            "OK",
            "Done",
            "Confirm",
            "Next",
            "确定",
            "完成",
            "确认",
        )

        /**
         * Only [DisplayOverlayMode.PURE_BLACK_IDLE] needs a full-screen surface to paint opaque
         * black pixels; both [DisplayOverlayMode.KEEP_AWAKE_ONLY] and [DisplayOverlayMode.STEALTH_DIM]
         * use a 1x1 pixel overlay so WindowManager applies `FLAG_KEEP_SCREEN_ON` and
         * `screenBrightness` display-wide without allocating a full-screen RGBA8888 SurfaceFlinger layer.
         */
        internal fun overlayDimensionForMode(mode: DisplayOverlayMode): Int =
            if (mode == DisplayOverlayMode.PURE_BLACK_IDLE) {
                WindowManager.LayoutParams.MATCH_PARENT
            } else {
                1
            }

        /**
         * Verifies that the SystemUI dialog tree contains BOTH a screen recording/casting phrase
         * AND our app identifier ("VeloDeck" / "极控" / "com.velodeck.agent").
         */
        fun isVeloDeckProjectionDialog(windowTexts: Collection<String>): Boolean {
            if (windowTexts.isEmpty()) return false
            val hasProjectionPhrase = windowTexts.any { txt ->
                PROJECTION_DIALOG_PHRASES.any { phrase -> txt.contains(phrase, ignoreCase = true) }
            }
            if (!hasProjectionPhrase) return false
            return windowTexts.any { txt ->
                APP_IDENTIFIERS.any { appId -> txt.contains(appId, ignoreCase = true) }
            }
        }

        /**
         * Explicitly arms the narrow window during which our own [ProjectionConsentActivity]
         * triggered the system MediaProjection dialog. Automatically expires after [timeoutMs]
         * (capped at [MAX_AUTO_ACCEPT_WINDOW_MS]).
         */
        fun armAutoAcceptProjection(timeoutMs: Long = MAX_AUTO_ACCEPT_WINDOW_MS) {
            autoAcceptUntilElapsedMs.set(
                SystemClock.elapsedRealtime() + timeoutMs.coerceIn(1_000L, MAX_AUTO_ACCEPT_WINDOW_MS),
            )
            instance?.startAutoAcceptPollLoop()
        }

        fun disarmAutoAcceptProjection() {
            autoAcceptUntilElapsedMs.set(0L)
        }
    }
}
