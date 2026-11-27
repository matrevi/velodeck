package com.velodeck.agent.service

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.Surface
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.velodeck.agent.R
import com.velodeck.agent.capture.ProjectionConsentActivity
import com.velodeck.agent.capture.ScreenCaptureManager
import com.velodeck.agent.input.VeloDeckAccessibilityService
import com.velodeck.agent.network.DetectedEndpoints
import com.velodeck.agent.network.DirectServer
import com.velodeck.agent.network.NetworkUtils
import com.velodeck.agent.network.RelayClient
import com.velodeck.agent.network.RelayConnectionState
import com.velodeck.agent.network.SessionCoordinator
import com.velodeck.agent.protocol.DeviceCapabilities
import com.velodeck.agent.protocol.DeviceSummary
import com.velodeck.agent.protocol.PartialDeviceCapabilities
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.storage.AgentConfigStore
import com.velodeck.agent.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

data class AgentRuntimeState(
    val serviceRunning: Boolean = false,
    val relayState: RelayConnectionState = RelayConnectionState.DISABLED,
    val relayMessage: String? = null,
    val controlCode: String = "",
    val ownerUsername: String = "",
    val directRunning: Boolean = false,
    val endpoints: DetectedEndpoints = DetectedEndpoints(null, emptyList(), AgentConfigStore.DEFAULT_DIRECT_PORT),
    val hasProjection: Boolean = false,
    val accessibilityConnected: Boolean = false,
    val activeSessions: Int = 0,
    val webrtcSupported: Boolean = false,
    val blackScreenActive: Boolean = false,
    val forcePortraitActive: Boolean = true,
)

class AgentForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var configStore: AgentConfigStore
    private lateinit var captureManager: ScreenCaptureManager
    private lateinit var coordinator: SessionCoordinator
    private lateinit var relayClient: RelayClient
    private lateinit var directServer: DirectServer
    private lateinit var networkMonitor: NetworkMonitor

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val wifiLockLock = Any()

    private var lastBatteryLevel: Int = -1
    private var lastBatteryCharging: Boolean? = null
    private var receiverRegistered: Boolean = false

    private var appliedRelayUrl: String? = null
    private var appliedAuthToken: String? = null
    private var appliedPendingUnbind: Boolean? = null
    private var appliedDeviceName: String? = null
    private var appliedAccessToken: String? = null
    private var appliedControlPassword: String? = null
    private val projectionRecoveryMutex = Mutex()
    private val overlaySyncLock = Any()
    private var lastSyncedOverlayMode: VeloDeckAccessibilityService.DisplayOverlayMode? = null
    private var lastSyncedForcePortrait: Boolean? = null
    private var lastSyncedOverlayA11y: VeloDeckAccessibilityService? = null

    @Volatile
    private var endpointsPopulated: Boolean = false

    @Volatile
    private var lastPowerWakeExitElapsedMs: Long = 0L

    @Volatile
    private var lastRemoteLockElapsedMs: Long = 0L

    fun markRemoteLockRequested() {
        lastRemoteLockElapsedMs = SystemClock.elapsedRealtime()
    }

    private val systemStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                Intent.ACTION_BATTERY_CHANGED -> {
                    val snap = PowerHelper.getBatterySnapshot(this@AgentForegroundService)
                    if (snap.levelPercent != lastBatteryLevel || snap.charging != lastBatteryCharging) {
                        lastBatteryLevel = snap.levelPercent
                        lastBatteryCharging = snap.charging
                        pushTelemetryUpdate()
                    }
                }

                Intent.ACTION_SCREEN_OFF -> {
                    val now = SystemClock.elapsedRealtime()
                    val recentRemoteLock = lastRemoteLockElapsedMs > 0L &&
                        (now - lastRemoteLockElapsedMs) < REMOTE_LOCK_IGNORE_MS
                    val st = _runtimeState.value
                    if (recentRemoteLock) {
                        Log.i(TAG, "Ignoring ACTION_SCREEN_OFF auto-exit after deliberate remote LOCK command")
                    } else if (
                        st.activeSessions > 0 &&
                        (st.blackScreenActive || configStore.current.blackScreenMode) &&
                        (now - lastPowerWakeExitElapsedMs) > 900L
                    ) {
                        // Active remote session with stealth black-screen mode: prevent real hardware
                        // Display.STATE_OFF from blacking out MediaProjection — immediately wake back
                        // into transparent minimum-backlight stealth dim so remote viewer keeps seeing 100%.
                        lastPowerWakeExitElapsedMs = now
                        Log.i(TAG, "ACTION_SCREEN_OFF during active remote session -> waking into stealth dim")
                        setBlackScreenActive(true, reason = "remote_stealth_keepalive")
                        mainHandler.postDelayed({
                            PowerHelper.wakeScreen(this@AgentForegroundService)
                            syncBlackScreenPresentation(forceRemoteViewing = true)
                            coordinator.requestActiveKeyframe()
                        }, 120L)
                    } else if (st.blackScreenActive && (now - lastPowerWakeExitElapsedMs) > 900L) {
                        // Physical Power/Lock key pressed while idle disguised black curtain was active:
                        // immediately remove black curtain and wake the screen back up so a single
                        // press of the lock key opens the phone normally!
                        lastPowerWakeExitElapsedMs = now
                        Log.i(TAG, "Power/Lock key pressed during Black-Screen mode -> dismissing curtain and waking screen")
                        setBlackScreenActive(false, reason = "power_key_pressed")
                        mainHandler.postDelayed({
                            PowerHelper.wakeScreen(this@AgentForegroundService)
                        }, 140L)
                    }
                    pushTelemetryUpdate()
                }

                Intent.ACTION_SCREEN_ON,
                Intent.ACTION_USER_PRESENT,
                -> {
                    pushTelemetryUpdate()
                }

                Intent.ACTION_CONFIGURATION_CHANGED -> {
                    captureManager.handleDisplayConfigChanged()
                    coordinator.webRtcManager.handleDisplayConfigChanged()
                    pushTelemetryUpdate()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        activeInstance = this
        Log.i(TAG, "AgentForegroundService onCreate")
        ensureNotificationChannels()
        PersistenceGuard.ensureAccessibilityEnabledIfPermitted(this)

        configStore = AgentConfigStore.getInstance(this)
        _runtimeState.update { it.copy(forcePortraitActive = configStore.current.forcePortrait) }
        captureManager = ScreenCaptureManager(
            context = this,
            onProjectionRevoked = {
                Log.w(TAG, "Projection revoked callback triggered in service")
                coordinator.onProjectionRevoked()
                promoteForeground(withMediaProjection = false)
                refreshRuntimeState()
                pushTelemetryUpdate()
            },
            onContentResized = {
                if (::coordinator.isInitialized) {
                    coordinator.webRtcManager.handleDisplayConfigChanged()
                }
                pushTelemetryUpdate()
            },
        )

        coordinator = SessionCoordinator(
            context = this,
            configStore = configStore,
            captureManager = captureManager,
            onSessionCountChanged = { count ->
                _runtimeState.update { it.copy(activeSessions = count) }
                syncWifiLockForActiveSessions(count)
                syncBlackScreenPresentation()
                updateNotification()
            },
            onEnsureProjection = { ensureProjectionReadyForSession() },
            onRemoteLockRequested = { markRemoteLockRequested() },
            onSessionWillStart = { handleSessionWillStart() },
            onSetBlackScreen = { enabled -> handleRemoteBlackScreenCommand(enabled) },
            onForcePortraitCommand = { enabled -> setForcePortraitEnabled(enabled) },
        )

        relayClient = RelayClient(
            registerBuilder = { buildRegisterMessage() },
            coordinator = coordinator,
            onStateChanged = { state, msg ->
                _runtimeState.update { it.copy(relayState = state, relayMessage = msg) }
                updateNotification()
            },
            onRegistered = { assignedCode, assignedOwner ->
                val cleanCode = assignedCode?.trim().orEmpty()
                val cleanOwner = assignedOwner?.trim().orEmpty()
                val updatedCfg = configStore.update { cur ->
                    val nextCode = cleanCode.ifEmpty { cur.controlCode }
                    val nextOwner = when {
                        cleanOwner.isNotEmpty() -> cleanOwner
                        cur.authToken.isBlank() -> ""
                        else -> cur.ownerUsername
                    }
                    // Clear pendingUnbindOwner once Relay confirms device has no bound owner
                    val nextPendingUnbind = if (cleanOwner.isEmpty()) false else cur.pendingUnbindOwner
                    cur.copy(
                        controlCode = nextCode,
                        ownerUsername = nextOwner,
                        pendingUnbindOwner = nextPendingUnbind,
                    )
                }
                appliedPendingUnbind = updatedCfg.pendingUnbindOwner
                _runtimeState.update {
                    it.copy(
                        controlCode = updatedCfg.controlCode,
                        ownerUsername = updatedCfg.ownerUsername,
                    )
                }
                updateNotification()
            },
            hasAuthTokenProvider = { configStore.current.authToken.isNotBlank() },
        )

        directServer = DirectServer(
            context = this,
            configStore = configStore,
            coordinator = coordinator,
            deviceSummaryProvider = { buildDeviceSummary() },
        )

        networkMonitor = NetworkMonitor(this) { networkChanged ->
            val endpoints = NetworkUtils.detectEndpoints(configStore.current.directPort)
            endpointsPopulated = true
            _runtimeState.update { it.copy(endpoints = endpoints) }
            if (configStore.current.relayEnabled) {
                if (networkChanged) {
                    relayClient.triggerReconnectNow()
                } else {
                    relayClient.probeLiveness()
                }
            }
        }

        // Start in SPECIAL_USE (API 34+) / untyped (API <34) foreground mode first before projection consent
        promoteForeground(withMediaProjection = false)
        acquireKeepAliveLocks()
        registerSystemReceivers()
        networkMonitor.start()

        _isRunning.value = true
        refreshRuntimeState()
        applyConfigAndStartTransports()

        if (configStore.current.autoStart) {
            WatchdogWorker.schedule(this)
        }

        // Eagerly initialize WebRTC PeerConnectionFactory (~90ms) at service startup so
        // `capabilities.webrtc` is immediately true as soon as MediaProjection is ready
        // (prevents controller race conditions that previously forced ws-jpeg fallback!).
        serviceScope.launch {
            val rtcReady = coordinator.isWebRtcAvailable
            _runtimeState.update { it.copy(webrtcSupported = rtcReady) }
            pushTelemetryUpdate()
        }

        // Proactive auto-recovery on service startup (e.g., after reboot or app update):
        // if Accessibility is already connected and the phone is unlocked, silently obtain
        // persistent MediaProjection once so the device is immediately 100% ready.
        serviceScope.launch {
            delay(1_200L)
            val cfg = configStore.current
            if (cfg.autoAcceptProjection &&
                VeloDeckAccessibilityService.connectedFlow.value &&
                !captureManager.hasProjection &&
                !PowerHelper.isDeviceLocked(this@AgentForegroundService)
            ) {
                Log.i(TAG, "Proactively recovering persistent MediaProjection on startup")
                ensureProjectionReadyForSession()
            }
        }

        // Observe live capability changes (Accessibility & MediaProjection)
        serviceScope.launch {
            VeloDeckAccessibilityService.connectedFlow.collect { connected ->
                _runtimeState.update { it.copy(accessibilityConnected = connected) }
                if (connected) {
                    syncBlackScreenPresentation()
                }
                pushTelemetryUpdate()
            }
        }
        serviceScope.launch {
            captureManager.hasProjectionFlow.collect { active ->
                _runtimeState.update { it.copy(hasProjection = active) }
                updateNotification()
                pushTelemetryUpdate()
            }
        }
        serviceScope.launch {
            directServer.runningFlow.collect { running ->
                _runtimeState.update { it.copy(directRunning = running) }
                updateNotification()
            }
        }
        serviceScope.launch {
            configStore.configFlow.collect { cfg ->
                if (_runtimeState.value.forcePortraitActive != cfg.forcePortrait) {
                    _runtimeState.update { it.copy(forcePortraitActive = cfg.forcePortrait) }
                    syncBlackScreenPresentation()
                    sendTelemetryNow()
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SET_PROJECTION -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                if (resultCode == Activity.RESULT_OK && resultData != null) {
                    // Android 14+ requires MEDIA_PROJECTION FGS type BEFORE getMediaProjection()!
                    promoteForeground(withMediaProjection = true)
                    // Ensure webrtcSupported flag is populated BEFORE setProjection emits hasProjectionFlow=true
                    val rtcReady = coordinator.isWebRtcAvailable
                    _runtimeState.update { it.copy(webrtcSupported = rtcReady) }
                    val ok = captureManager.setProjection(resultCode, resultData)
                    if (!ok) {
                        promoteForeground(withMediaProjection = false)
                    } else {
                        pushTelemetryUpdate()
                    }
                    refreshRuntimeState()
                    updateNotification()
                }
            }

            ACTION_APPLY_CONFIG -> {
                applyConfigAndStartTransports()
            }

            ACTION_ENTER_BLACK_SCREEN -> {
                setBlackScreenActive(true, reason = "user_action")
            }

            ACTION_EXIT_BLACK_SCREEN -> {
                setBlackScreenActive(false, reason = "user_action")
            }

            ACTION_SET_FORCE_PORTRAIT -> {
                val enabled = intent.getBooleanExtra(EXTRA_FORCE_PORTRAIT_ENABLED, configStore.current.forcePortrait)
                setForcePortraitEnabled(enabled)
            }

            ACTION_DISCONNECT_SESSIONS -> {
                Log.i(TAG, "Owner kill switch activated: terminating all active remote sessions")
                coordinator.disconnectAllSessions("owner_kill_switch")
                directServer.revokeAllClients("owner_kill_switch")
                refreshRuntimeState()
                updateNotification()
            }

            ACTION_STOP -> {
                Log.i(TAG, "Stopping AgentForegroundService per user request")
                WatchdogWorker.cancel(this)
                coordinator.disconnectAllSessions("service_stopped")
                directServer.revokeAllClients("service_stopped")
                stopSelf()
                return START_NOT_STICKY
            }

            else -> {
                refreshRuntimeState()
                updateNotification()
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (configStore.current.autoStart) {
            Log.i(TAG, "Task removed from Recents; scheduling immediate service revival")
            PersistenceGuard.ensureAccessibilityEnabledIfPermitted(this)
            PersistenceGuard.scheduleServiceRestart(this, delayMs = 1_500L)
        }
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground service timeout triggered (startId=$startId, fgsType=$fgsType); recovering cleanly")
        try {
            if (::coordinator.isInitialized) {
                coordinator.disconnectAllSessions("fgs_timeout")
            }
            if (::captureManager.isInitialized && captureManager.hasProjection) {
                captureManager.pauseStreaming()
                promoteForeground(withMediaProjection = false)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to demote projection during onTimeout", t)
        }
        if (::configStore.isInitialized && configStore.current.autoStart) {
            PersistenceGuard.ensureAccessibilityEnabledIfPermitted(this)
            PersistenceGuard.scheduleServiceRestart(this, delayMs = 2_000L)
        }
        stopSelf()
    }

    /**
     * Automatically recovers persistent [MediaProjection] when an incoming remote control
     * session arrives after a reboot, app update, or ROM reclaim — with zero manual touch
     * on the phone whenever Accessibility + autoAcceptProjection are active.
     */
    private suspend fun ensureProjectionReadyForSession(): Boolean {
        if (captureManager.hasProjection) return true
        return projectionRecoveryMutex.withLock {
            if (captureManager.hasProjection) return@withLock true
            val cfg = configStore.current
            if (!cfg.autoAcceptProjection) {
                Log.w(TAG, "Skipping auto-projection recovery because autoAcceptProjection=false")
                return@withLock false
            }

            // Self-heal Accessibility first if WRITE_SECURE_SETTINGS was granted
            if (!VeloDeckAccessibilityService.connectedFlow.value) {
                if (PersistenceGuard.ensureAccessibilityEnabledIfPermitted(this)) {
                    withTimeoutOrNull(2_000L) {
                        VeloDeckAccessibilityService.connectedFlow.first { it }
                    }
                }
            }

            val a11y = VeloDeckAccessibilityService.instance
            if (a11y == null) {
                Log.w(TAG, "Cannot auto-recover MediaProjection: AccessibilityService not connected")
                return@withLock false
            }

            // Wake & unlock device if needed so SystemUI can display the projection consent dialog
            if (!PowerHelper.isScreenOn(this)) {
                PowerHelper.wakeScreen(this)
                delay(350L)
            }
            if (PowerHelper.isDeviceLocked(this)) {
                val (unlocked, msg) = a11y.performUnlock(cfg.unlockPin)
                Log.i(TAG, "Pre-projection unlock attempt: unlocked=$unlocked ($msg)")
                if (!unlocked) {
                    return@withLock false
                }
                delay(300L)
            }

            Log.i(TAG, "Launching ProjectionConsentActivity for zero-touch auto-recovery")
            try {
                ProjectionConsentActivity.launch(this)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to launch ProjectionConsentActivity for auto-recovery", t)
                return@withLock false
            }

            val recovered = withTimeoutOrNull(6_000L) {
                captureManager.hasProjectionFlow.first { it }
            } == true
            Log.i(TAG, "Zero-touch MediaProjection auto-recovery result=$recovered")
            recovered
        }
    }

    override fun onDestroy() {
        Log.i(TAG, "AgentForegroundService onDestroy")
        if (activeInstance === this) {
            activeInstance = null
        }
        synchronized(overlaySyncLock) {
            lastSyncedOverlayMode = null
            lastSyncedForcePortrait = null
            lastSyncedOverlayA11y = null
        }
        val forcePortraitOnExit = if (::configStore.isInitialized) configStore.current.forcePortrait else false
        BlackScreenActivity.dismissIfActive()
        VeloDeckAccessibilityService.instance?.updateDisplayOverlay(
            mode = VeloDeckAccessibilityService.DisplayOverlayMode.OFF,
            forcePortrait = forcePortraitOnExit,
        )
        _isRunning.value = false
        endpointsPopulated = false
        unregisterSystemReceivers()
        networkMonitor.stop()
        relayClient.shutdown()
        directServer.shutdown()
        coordinator.shutdown()
        captureManager.shutdown()
        releaseKeepAliveLocks()
        mainHandler.removeCallbacksAndMessages(null)
        serviceScope.cancel()
        val cfg = configStore.current
        _runtimeState.value = AgentRuntimeState(
            serviceRunning = false,
            controlCode = cfg.controlCode,
            ownerUsername = cfg.ownerUsername,
            accessibilityConnected = VeloDeckAccessibilityService.connectedFlow.value,
            forcePortraitActive = cfg.forcePortrait,
        )
        super.onDestroy()
    }

    private fun applyConfigAndStartTransports() {
        val cfg = configStore.current
        val trimmedRelayUrl = cfg.relayUrl.trim()

        val credentialsChanged = (appliedAccessToken != null && appliedAccessToken != cfg.accessToken) ||
            (appliedControlPassword != null && appliedControlPassword != cfg.controlPassword)

        val relayIdentityChanged =
            (appliedRelayUrl != null && appliedRelayUrl != trimmedRelayUrl) ||
            (appliedAuthToken != null && appliedAuthToken != cfg.authToken) ||
            (appliedPendingUnbind != null && appliedPendingUnbind != cfg.pendingUnbindOwner) ||
            (appliedDeviceName != null && appliedDeviceName != cfg.deviceName) ||
            (appliedControlPassword != null && appliedControlPassword != cfg.controlPassword)

        appliedRelayUrl = trimmedRelayUrl
        appliedAuthToken = cfg.authToken
        appliedPendingUnbind = cfg.pendingUnbindOwner
        appliedDeviceName = cfg.deviceName
        appliedAccessToken = cfg.accessToken
        appliedControlPassword = cfg.controlPassword

        if (credentialsChanged) {
            directServer.revokeAllClients("credentials_changed")
        }

        val endpoints = NetworkUtils.detectEndpoints(cfg.directPort)
        endpointsPopulated = true
        val forcePortraitChanged = _runtimeState.value.forcePortraitActive != cfg.forcePortrait
        _runtimeState.update {
            it.copy(
                endpoints = endpoints,
                controlCode = cfg.controlCode,
                ownerUsername = cfg.ownerUsername,
                forcePortraitActive = cfg.forcePortrait,
            )
        }

        if (cfg.directEnabled) {
            directServer.start(cfg.directPort)
        } else {
            directServer.stop()
        }

        if (cfg.relayEnabled && trimmedRelayUrl.isNotBlank()) {
            relayClient.start(trimmedRelayUrl, forceReconnect = relayIdentityChanged)
        } else {
            relayClient.stop(RelayConnectionState.DISABLED)
        }

        if (cfg.autoStart) {
            WatchdogWorker.schedule(this)
        } else {
            WatchdogWorker.cancel(this)
        }

        if (!cfg.blackScreenMode && _runtimeState.value.blackScreenActive) {
            setBlackScreenActive(false, reason = "config_disabled")
        } else {
            syncBlackScreenPresentation()
        }

        if (forcePortraitChanged) {
            sendTelemetryNow()
        }

        updateNotification()
    }

    private fun handleSessionWillStart() {
        val cfg = configStore.current
        val wasScreenOff = !PowerHelper.isScreenOn(this)
        if (wasScreenOff) {
            // Wake screen automatically so SurfaceFlinger resumes producing non-black frames for MediaProjection.
            // If blackScreenMode is enabled in config, engage stealth-dim automatically so the wake stays discreet.
            if (cfg.blackScreenMode && !_runtimeState.value.blackScreenActive) {
                _runtimeState.update { it.copy(blackScreenActive = true) }
            }
            PowerHelper.wakeScreen(this)
        }
        syncBlackScreenPresentation(forceRemoteViewing = true)
        mainHandler.postDelayed({
            if (::coordinator.isInitialized) {
                coordinator.requestActiveKeyframe()
            }
            pushTelemetryUpdate()
        }, 200L)
    }

    private fun handleRemoteBlackScreenCommand(enabled: Boolean): Boolean {
        if (enabled && !PowerHelper.isScreenOn(this)) {
            // Real hardware Display.STATE_OFF makes MediaProjection output pure black; wake first
            // then drop physical display to hardware minimum backlight via stealth-dim overlay.
            PowerHelper.wakeScreen(this)
        }
        setBlackScreenActive(enabled, reason = "remote_command")
        if (enabled) {
            mainHandler.postDelayed({
                if (::coordinator.isInitialized) {
                    coordinator.requestActiveKeyframe()
                }
                pushTelemetryUpdate()
            }, 220L)
        }
        return true
    }

    private fun setBlackScreenActive(active: Boolean, reason: String) {
        Log.i(TAG, "Black-Screen running mode -> $active (reason=$reason)")
        _runtimeState.update { it.copy(blackScreenActive = active) }
        syncBlackScreenPresentation()
        updateNotification()
        sendTelemetryNow()
    }

    fun setForcePortraitEnabled(enabled: Boolean): Boolean {
        Log.i(TAG, "Force-Portrait mode -> $enabled")
        configStore.update { cur ->
            if (cur.forcePortrait == enabled) cur else cur.copy(forcePortrait = enabled)
        }
        _runtimeState.update { it.copy(forcePortraitActive = enabled) }
        syncBlackScreenPresentation()
        sendTelemetryNow()
        return true
    }

    private fun syncBlackScreenPresentation(forceRemoteViewing: Boolean = false) {
        val st = _runtimeState.value
        val a11y = VeloDeckAccessibilityService.instance
        val remoteViewing = forceRemoteViewing || st.activeSessions > 0

        val targetMode = when {
            st.blackScreenActive && !remoteViewing -> VeloDeckAccessibilityService.DisplayOverlayMode.PURE_BLACK_IDLE
            st.blackScreenActive && remoteViewing -> VeloDeckAccessibilityService.DisplayOverlayMode.STEALTH_DIM
            !st.blackScreenActive && remoteViewing -> VeloDeckAccessibilityService.DisplayOverlayMode.KEEP_AWAKE_ONLY
            else -> VeloDeckAccessibilityService.DisplayOverlayMode.OFF
        }

        val unchanged = synchronized(overlaySyncLock) {
            val same = lastSyncedOverlayMode == targetMode &&
                lastSyncedForcePortrait == st.forcePortraitActive &&
                lastSyncedOverlayA11y === a11y
            if (!same) {
                lastSyncedOverlayMode = targetMode
                lastSyncedForcePortrait = st.forcePortraitActive
                lastSyncedOverlayA11y = a11y
            }
            same
        }
        if (unchanged) {
            return
        }

        if (remoteViewing) {
            BlackScreenActivity.dismissIfActive()
        }

        if (a11y != null) {
            val applied = a11y.updateDisplayOverlay(
                mode = targetMode,
                forcePortrait = st.forcePortraitActive,
            ) {
                setBlackScreenActive(false, reason = "emergency_tap")
            }
            if (!applied) {
                synchronized(overlaySyncLock) {
                    if (lastSyncedOverlayA11y === a11y &&
                        lastSyncedOverlayMode == targetMode &&
                        lastSyncedForcePortrait == st.forcePortraitActive
                    ) {
                        lastSyncedOverlayMode = null
                        lastSyncedForcePortrait = null
                        lastSyncedOverlayA11y = null
                    }
                }
                if (targetMode == VeloDeckAccessibilityService.DisplayOverlayMode.PURE_BLACK_IDLE) {
                    BlackScreenActivity.launch(this)
                }
            }
        } else {
            if (targetMode == VeloDeckAccessibilityService.DisplayOverlayMode.PURE_BLACK_IDLE) {
                BlackScreenActivity.launch(this)
            } else {
                BlackScreenActivity.dismissIfActive()
            }
        }

        // Belt-and-suspenders system rotation lock when WRITE_SETTINGS is granted
        if (st.forcePortraitActive && Settings.System.canWrite(this)) {
            runCatching {
                Settings.System.putInt(contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0)
                Settings.System.putInt(contentResolver, Settings.System.USER_ROTATION, Surface.ROTATION_0)
            }
        }

        if (remoteViewing && ::coordinator.isInitialized) {
            mainHandler.postDelayed({
                coordinator.requestActiveKeyframe()
            }, 150L)
        }
    }

    private fun buildCapabilities(): DeviceCapabilities {
        val a11y = VeloDeckAccessibilityService.connectedFlow.value
        val proj = captureManager.hasProjection
        val rtc = _runtimeState.value.webrtcSupported && proj
        return DeviceCapabilities(
            webrtc = rtc,
            wsJpeg = true,
            wsH264 = false,
            wake = true,
            unlock = a11y,
            accessibility = a11y,
            mediaProjection = proj,
            rootOrShizuku = false,
            p2pFileTransfer = rtc,
        )
    }

    private fun buildDeviceSummary(): DeviceSummary {
        val cfg = configStore.current
        val geom = captureManager.getDisplayGeometry()
        val batt = PowerHelper.getBatterySnapshot(this)
        val cachedEndpoints = _runtimeState.value.endpoints
        val endpoints = if (endpointsPopulated && cachedEndpoints.port == cfg.directPort) {
            cachedEndpoints
        } else {
            NetworkUtils.detectEndpoints(cfg.directPort).also { detected ->
                endpointsPopulated = true
                _runtimeState.update { it.copy(endpoints = detected) }
            }
        }
        return DeviceSummary(
            deviceId = cfg.deviceId,
            controlCode = cfg.controlCode.takeIf { it.isNotBlank() },
            ownerUsername = cfg.ownerUsername.takeIf { it.isNotBlank() },
            name = cfg.deviceName,
            model = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            androidVersion = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString(),
            online = true,
            lastSeen = System.currentTimeMillis(),
            screenWidth = geom.width,
            screenHeight = geom.height,
            rotation = geom.rotation,
            battery = batt.levelPercent,
            charging = batt.charging,
            locked = PowerHelper.isDeviceLocked(this),
            screenOn = PowerHelper.isScreenOn(this),
            blackScreenActive = _runtimeState.value.blackScreenActive,
            forcePortraitActive = _runtimeState.value.forcePortraitActive,
            directUrl = if (cfg.directEnabled) endpoints.preferredDirectWsUrl else null,
            capabilities = buildCapabilities(),
        )
    }

    private fun buildRegisterMessage(): WireMessage.AgentRegister {
        val cfg = configStore.current
        val summary = buildDeviceSummary()
        return WireMessage.AgentRegister(
            deviceId = cfg.deviceId,
            deviceSecret = cfg.deviceSecret,
            // P0-6: Never upload the local DirectServer accessToken to the public Relay server!
            accessToken = null,
            authToken = cfg.authToken.takeIf { it.isNotBlank() },
            unbindOwner = if (cfg.pendingUnbindOwner && cfg.authToken.isBlank()) true else null,
            controlPassword = cfg.controlPassword.takeIf { it.isNotBlank() },
            name = summary.name,
            model = summary.model,
            androidVersion = summary.androidVersion,
            screenWidth = summary.screenWidth,
            screenHeight = summary.screenHeight,
            rotation = summary.rotation,
            battery = summary.battery,
            charging = summary.charging,
            locked = summary.locked,
            screenOn = summary.screenOn,
            blackScreenActive = summary.blackScreenActive,
            forcePortraitActive = summary.forcePortraitActive,
            directUrl = summary.directUrl,
            capabilities = summary.capabilities,
        )
    }

    private fun sendTelemetryNow() {
        if (::relayClient.isInitialized && ::directServer.isInitialized && ::captureManager.isInitialized) {
            pushTelemetryUpdate()
        }
    }

    private fun pushTelemetryUpdate() {
        val summary = buildDeviceSummary()
        val cap = summary.capabilities
        val telemetry = WireMessage.AgentTelemetry(
            deviceId = summary.deviceId,
            screenWidth = summary.screenWidth,
            screenHeight = summary.screenHeight,
            rotation = summary.rotation,
            battery = summary.battery,
            charging = summary.charging,
            locked = summary.locked,
            screenOn = summary.screenOn,
            blackScreenActive = summary.blackScreenActive,
            forcePortraitActive = summary.forcePortraitActive,
            capabilities = PartialDeviceCapabilities(
                webrtc = cap.webrtc,
                wsJpeg = cap.wsJpeg,
                wsH264 = cap.wsH264,
                wake = cap.wake,
                unlock = cap.unlock,
                accessibility = cap.accessibility,
                mediaProjection = cap.mediaProjection,
                rootOrShizuku = cap.rootOrShizuku,
                p2pFileTransfer = cap.p2pFileTransfer,
            ),
        )
        relayClient.sendTelemetry(telemetry)
        directServer.broadcastDeviceStatus(summary)
    }

    private fun refreshRuntimeState() {
        val cfg = configStore.current
        val detectedEndpoints = NetworkUtils.detectEndpoints(cfg.directPort)
        endpointsPopulated = true
        _runtimeState.update { prev ->
            prev.copy(
                serviceRunning = true,
                controlCode = cfg.controlCode,
                ownerUsername = cfg.ownerUsername,
                directRunning = directServer.runningFlow.value,
                endpoints = detectedEndpoints,
                hasProjection = captureManager.hasProjection,
                accessibilityConnected = VeloDeckAccessibilityService.connectedFlow.value,
                activeSessions = coordinator.activeSessionCount.value,
                forcePortraitActive = cfg.forcePortrait,
            )
        }
    }

    private fun promoteForeground(withMediaProjection: Boolean) {
        val notif = buildNotification()
        val baseType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && withMediaProjection) {
            baseType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            baseType
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notif, type)
        } catch (t: Throwable) {
            Log.e(TAG, "startForeground failed with type=$type; retrying with fallback type", t)
            val fallbackType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && withMediaProjection) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            } else {
                0
            }
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notif, fallbackType)
            } catch (fallbackErr: Throwable) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE && fallbackType != 0) {
                    Log.e(TAG, "Fallback startForeground failed with type=$fallbackType; retrying with type=0", fallbackErr)
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, notif, 0)
                } else {
                    throw fallbackErr
                }
            }
        }
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val st = _runtimeState.value
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        if (st.activeSessions > 0) {
            val disconnectIntent = Intent(this, AgentForegroundService::class.java).apply {
                action = ACTION_DISCONNECT_SESSIONS
            }
            val disconnectPi = PendingIntent.getService(
                this,
                REQ_CODE_DISCONNECT,
                disconnectIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val stopIntent = Intent(this, AgentForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            val stopPi = PendingIntent.getService(
                this,
                REQ_CODE_STOP,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val publicActiveNotif = NotificationCompat.Builder(this, CHANNEL_ACTIVE_SESSION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("⚠️ 正在被远程控制")
                .setContentText("解锁后可立即断开远程控制")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .build()

            return NotificationCompat.Builder(this, CHANNEL_ACTIVE_SESSION)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("⚠️ 正在被远程控制")
                .setContentText("当前有 ${st.activeSessions} 个活跃控制会话 · 点击下方按钮立即断开")
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setPublicVersion(publicActiveNotif)
                .setColor(ContextCompat.getColor(this, R.color.status_err))
                .setContentIntent(pi)
                .addAction(0, "立即断开控制", disconnectPi)
                .addAction(0, "停止服务", stopPi)
                .build()
        }

        val parts = mutableListOf<String>()
        when (st.relayState) {
            RelayConnectionState.CONNECTED -> parts.add("云端在线")
            RelayConnectionState.CONNECTING -> parts.add("云端连接中")
            RelayConnectionState.AUTH_ERROR -> parts.add("账号需重新登录")
            RelayConnectionState.DISCONNECTED -> parts.add("云端重连中")
            RelayConnectionState.DISABLED -> Unit
        }
        if (st.controlCode.isNotBlank()) {
            parts.add("控制码 ${ProtocolCodec.formatControlCode(st.controlCode)}")
        }
        if (st.directRunning) {
            parts.add("直连 :${st.endpoints.port}")
        }
        parts.add(if (st.hasProjection) "录屏就绪" else "待录屏授权")
        val contentText = parts.joinToString(" · ")

        // Redacted lockscreen notification: never expose controlCode on lockscreen!
        val publicIdleNotif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("VeloDeck 极控后台保护运行中")
            .setContentText("已隐藏敏感连接信息")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        val idleBuilder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(
                if (st.blackScreenActive) "VeloDeck 极控伪装黑屏运行中（按锁屏键打开）" else "VeloDeck 极控无人值守服务运行中",
            )
            .setContentText(contentText)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicIdleNotif)
            .setContentIntent(pi)

        if (configStore.current.blackScreenMode || st.blackScreenActive) {
            val toggleIntent = Intent(this, AgentForegroundService::class.java).apply {
                action = if (st.blackScreenActive) ACTION_EXIT_BLACK_SCREEN else ACTION_ENTER_BLACK_SCREEN
            }
            val togglePi = PendingIntent.getService(
                this,
                REQ_CODE_BLACK_SCREEN,
                toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            idleBuilder.addAction(
                0,
                if (st.blackScreenActive) "退出伪装黑屏" else "进入伪装黑屏",
                togglePi,
            )
        }

        return idleBuilder.build()
    }

    private fun ensureNotificationChannels() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val idleChannel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notif_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.notif_channel_desc)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                setShowBadge(false)
            }
            nm.createNotificationChannel(idleChannel)
        }
        if (nm.getNotificationChannel(CHANNEL_ACTIVE_SESSION) == null) {
            val activeChannel = NotificationChannel(
                CHANNEL_ACTIVE_SESSION,
                getString(R.string.notif_active_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.notif_active_channel_desc)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                setShowBadge(true)
            }
            nm.createNotificationChannel(activeChannel)
        }
    }

    private fun acquireKeepAliveLocks() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VeloDeck:KeepAlive").apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to acquire PARTIAL_WAKE_LOCK", t)
        }
    }

    /**
     * Dynamically holds `WIFI_MODE_FULL_LOW_LATENCY` ONLY while at least one remote control
     * session is active, releasing immediately when idle so 7x24 operation saves battery and
     * avoids OEM (ColorOS/MIUI/OriginOS) aggressive Wi-Fi lock killers.
     */
    private fun syncWifiLockForActiveSessions(activeSessions: Int) {
        synchronized(wifiLockLock) {
            if (activeSessions > 0) {
                if (wifiLock?.isHeld == true) return
                try {
                    val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    } else {
                        @Suppress("DEPRECATION")
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF
                    }
                    val lock = wifiLock ?: wm.createWifiLock(mode, "VeloDeck:WifiKeepAlive").apply {
                        setReferenceCounted(false)
                    }.also { wifiLock = it }
                    if (!lock.isHeld) {
                        lock.acquire()
                        Log.i(TAG, "Acquired low-latency WifiLock for $activeSessions active session(s)")
                    }
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to acquire WifiLock", t)
                }
            } else {
                try {
                    if (wifiLock?.isHeld == true) {
                        wifiLock?.release()
                        Log.i(TAG, "Released low-latency WifiLock (idle)")
                    }
                } catch (_: Throwable) {
                }
            }
        }
    }

    private fun releaseKeepAliveLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Throwable) {
        }
        wakeLock = null
        synchronized(wifiLockLock) {
            try {
                if (wifiLock?.isHeld == true) wifiLock?.release()
            } catch (_: Throwable) {
            }
            wifiLock = null
        }
    }

    private fun registerSystemReceivers() {
        if (receiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_CONFIGURATION_CHANGED)
        }
        ContextCompat.registerReceiver(this, systemStateReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
    }

    private fun unregisterSystemReceivers() {
        if (!receiverRegistered) return
        try {
            unregisterReceiver(systemStateReceiver)
        } catch (_: Throwable) {
        }
        receiverRegistered = false
    }

    companion object {
        private const val TAG = "AgentForegroundService"
        private const val REMOTE_LOCK_IGNORE_MS = 1_500L
        private const val CHANNEL_ID = "velodeck_agent_service_channel"
        private const val CHANNEL_ACTIVE_SESSION = "velodeck_active_session_channel"
        private const val NOTIFICATION_ID = 1001
        private const val REQ_CODE_DISCONNECT = 101
        private const val REQ_CODE_STOP = 102
        private const val REQ_CODE_BLACK_SCREEN = 103

        const val ACTION_START = "com.velodeck.agent.action.START"
        const val ACTION_STOP = "com.velodeck.agent.action.STOP"
        const val ACTION_APPLY_CONFIG = "com.velodeck.agent.action.APPLY_CONFIG"
        const val ACTION_SET_PROJECTION = "com.velodeck.agent.action.SET_PROJECTION"
        const val ACTION_DISCONNECT_SESSIONS = "com.velodeck.agent.action.DISCONNECT_SESSIONS"
        const val ACTION_ENTER_BLACK_SCREEN = "com.velodeck.agent.action.ENTER_BLACK_SCREEN"
        const val ACTION_EXIT_BLACK_SCREEN = "com.velodeck.agent.action.EXIT_BLACK_SCREEN"
        const val ACTION_SET_FORCE_PORTRAIT = "com.velodeck.agent.action.SET_FORCE_PORTRAIT"

        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        const val EXTRA_FORCE_PORTRAIT_ENABLED = "force_portrait_enabled"

        @Volatile
        private var activeInstance: AgentForegroundService? = null

        private val _isRunning = MutableStateFlow(false)
        val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

        private val _runtimeState = MutableStateFlow(AgentRuntimeState())
        val runtimeState: StateFlow<AgentRuntimeState> = _runtimeState.asStateFlow()

        fun start(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_START
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.applicationContext.startService(intent)
        }

        fun applyConfig(context: Context) {
            if (!_isRunning.value) return
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_APPLY_CONFIG
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun deliverProjectionConsent(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_SET_PROJECTION
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun enterBlackScreen(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_ENTER_BLACK_SCREEN
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun exitBlackScreen(context: Context) {
            if (!_isRunning.value) {
                val forcePortrait = AgentConfigStore.getInstance(context).current.forcePortrait
                VeloDeckAccessibilityService.instance?.updateDisplayOverlay(
                    mode = VeloDeckAccessibilityService.DisplayOverlayMode.OFF,
                    forcePortrait = forcePortrait,
                )
                BlackScreenActivity.dismissIfActive()
                return
            }
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_EXIT_BLACK_SCREEN
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun setForcePortraitEnabled(context: Context, enabled: Boolean) {
            AgentConfigStore.getInstance(context).update { cur ->
                if (cur.forcePortrait == enabled) cur else cur.copy(forcePortrait = enabled)
            }
            _runtimeState.update { it.copy(forcePortraitActive = enabled) }
            if (!_isRunning.value) {
                VeloDeckAccessibilityService.instance?.updateDisplayOverlay(
                    mode = VeloDeckAccessibilityService.DisplayOverlayMode.OFF,
                    forcePortrait = enabled,
                )
                return
            }
            val intent = Intent(context, AgentForegroundService::class.java).apply {
                action = ACTION_SET_FORCE_PORTRAIT
                putExtra(EXTRA_FORCE_PORTRAIT_ENABLED, enabled)
            }
            ContextCompat.startForegroundService(context.applicationContext, intent)
        }

        fun requestOverlaySync() {
            val svc = activeInstance ?: return
            svc.mainHandler.post {
                svc.syncBlackScreenPresentation()
            }
        }
    }
}
