package com.velodeck.agent.capture

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import com.velodeck.agent.protocol.IceServerConfig
import com.velodeck.agent.protocol.RtcIceCandidateInit
import com.velodeck.agent.protocol.StreamQuality
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoFrame
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs

interface WebRtcCallbacks {
    fun onLocalOffer(sessionId: String, sdp: String)
    fun onLocalAnswer(sessionId: String, sdp: String)
    fun onLocalIceCandidate(sessionId: String, candidate: RtcIceCandidateInit)
    fun onDataChannelMessage(sessionId: String, text: String)
    fun onWebRtcDisconnected(sessionId: String, reason: String)
    fun onFileChannelText(sessionId: String, text: String) {}
    fun onFileChannelBinary(sessionId: String, bytes: ByteArray) {}
    fun onFileChannelClosed(sessionId: String) {}
}

/**
 * Real WebRTC Video + DataChannel engine backed by `io.getstream:stream-webrtc-android`.
 * Feeds frames zero-copy from [ScreenCaptureManager]'s persistent VirtualDisplay via [SurfaceTextureHelper].
 *
 * Concurrency & Deadlock-Freedom Invariant:
 * - NEVER hold any lock across `PeerConnection`, `SurfaceTextureHelper`, or `DataChannel` JNI calls,
 *   because libwebrtc synchronously marshals JNI calls onto its internal `signaling_thread` while
 *   `PeerConnection.Observer` / `SdpObserver` callbacks execute ON `signaling_thread`.
 * - All signaling & lifecycle operations serialize on a single dedicated [rtcExecutor] thread,
 *   while [stateLock] only guards nanosecond-fast in-memory field reads/writes.
 */
class WebRtcSessionManager(
    context: Context,
    private val captureManager: ScreenCaptureManager,
    private val callbacks: WebRtcCallbacks,
) {
    private val appContext = context.applicationContext
    private val initLock = Any()
    private val stateLock = Any()
    private val rtcExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "VeloDeckWebRtc").apply { isDaemon = true }
    }

    @Volatile
    private var eglBase: EglBase? = null

    @Volatile
    private var encoderFactory: LowLatencyH264EncoderFactory? = null

    @Volatile
    private var factory: PeerConnectionFactory? = null
    private val initialized = AtomicBoolean(false)
    private val initFailed = AtomicBoolean(false)

    @Volatile
    private var activeSessionId: String? = null

    @Volatile
    private var peerConnection: PeerConnection? = null

    @Volatile
    private var videoSource: VideoSource? = null

    @Volatile
    private var videoTrack: VideoTrack? = null

    @Volatile
    private var videoSender: RtpSender? = null

    @Volatile
    private var activeQuality: StreamQuality = StreamQuality.BALANCED

    @Volatile
    private var surfaceTextureHelper: SurfaceTextureHelper? = null

    @Volatile
    private var captureSurface: Surface? = null

    @Volatile
    private var controlDataChannel: DataChannel? = null

    @Volatile
    private var controlDataChannelOpen: Boolean = false

    @Volatile
    private var pointerDataChannel: DataChannel? = null

    @Volatile
    private var fileDataChannel: DataChannel? = null

    @Volatile
    private var fileDataChannelOpen: Boolean = false

    @Volatile
    private var remoteDescriptionSet: Boolean = false
    private val pendingRemoteIce = mutableListOf<RtcIceCandidateInit>()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lastFrameCapturedElapsedMs = AtomicLong(0L)
    private val lastRealFrameElapsedMs = AtomicLong(0L)
    private val capturedFrameCount = AtomicLong(0L)

    @Volatile
    private var framePumpRunnable: Runnable? = null

    @Volatile
    private var statsLogRunnable: Runnable? = null

    @Volatile
    private var statsLogSessionId: String? = null

    @Volatile
    private var sessionStartedElapsedMs: Long = 0L

    private var lastAdaptedWidth: Int = 0
    private var lastAdaptedHeight: Int = 0
    private var lastStatsBytesSent: Long = 0L
    private var lastStatsTimestampMs: Long = 0L
    private var statsPollTick: Int = 0
    private var isActiveRouteTurn: Boolean = false
    private val rttCongestionGuard = RttCongestionGuard()
    private var lastAppliedMaxBitrateKbps: Int = 0

    val isAvailable: Boolean
        get() = !initFailed.get() && ensureInitialized()

    private fun ensureInitialized(): Boolean {
        if (initialized.get()) return true
        if (initFailed.get()) return false
        synchronized(initLock) {
            if (initialized.get()) return true
            if (initFailed.get()) return false
            return try {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(appContext)
                        .setFieldTrials(WEBRTC_FIELD_TRIALS)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions(),
                )
                val egl = EglBase.create()
                eglBase = egl
                // Custom zero-copy LowLatencyH264EncoderFactory (clamped monotonic PTS, KEY_LOW_LATENCY=1,
                // KEY_LATENCY=1, KEY_PRIORITY=0, 60fps native rate control, intra-refresh, pooled buffers)
                // with automatic fallback via VideoEncoderFallback to DefaultVideoEncoderFactory.
                val h264Factory = LowLatencyH264EncoderFactory(egl.eglBaseContext)
                encoderFactory = h264Factory
                val decoderFactory = DefaultVideoDecoderFactory(egl.eglBaseContext)
                factory = PeerConnectionFactory.builder()
                    .setVideoEncoderFactory(h264Factory)
                    .setVideoDecoderFactory(decoderFactory)
                    .createPeerConnectionFactory()
                initialized.set(true)
                Log.i(TAG, "WebRTC PeerConnectionFactory initialized with LowLatencyH264EncoderFactory")
                true
            } catch (t: Throwable) {
                initFailed.set(true)
                Log.e(TAG, "WebRTC initialization failed; ws-jpeg fallback will be used", t)
                false
            }
        }
    }

    fun startSession(
        sessionId: String,
        iceServers: List<IceServerConfig>,
        quality: StreamQuality,
        createOfferImmediately: Boolean = false,
    ): Boolean {
        if (!ensureInitialized()) return false
        if (rtcExecutor.isShutdown) return false
        val cancelled = AtomicBoolean(false)
        return try {
            rtcExecutor.submit<Boolean> {
                startSessionOnExecutor(sessionId, iceServers, quality, createOfferImmediately, cancelled)
            }.get(START_SESSION_TIMEOUT_SEC, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            cancelled.set(true)
            Log.e(TAG, "startSession($sessionId) failed or timed out on rtcExecutor", t)
            if (!rtcExecutor.isShutdown) {
                try {
                    rtcExecutor.execute {
                        closeSessionOnExecutor(sessionId)
                    }
                } catch (_: Throwable) {
                }
            }
            false
        }
    }

    private fun startSessionOnExecutor(
        sessionId: String,
        iceServers: List<IceServerConfig>,
        quality: StreamQuality,
        createOfferImmediately: Boolean,
        cancelled: AtomicBoolean,
    ): Boolean {
        if (cancelled.get()) {
            Log.w(TAG, "startSessionOnExecutor($sessionId) skipped; already cancelled before start")
            return false
        }
        // Tear down any previous session sequentially on rtcExecutor without holding locks across JNI
        closeSessionInternal()
        resetAdaptiveRateState()
        if (cancelled.get()) {
            Log.w(TAG, "startSessionOnExecutor($sessionId) aborted after closing previous session")
            return false
        }

        val pcf = factory ?: return false
        val egl = eglBase ?: return false
        val (w, h) = captureManager.computeTargetDimensions(quality.maxWidth)

        val rtcIceServers = buildRtcIceServers(iceServers)
        val rtcConfig = PeerConnection.RTCConfiguration(rtcIceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            // Prevent P2P TCP host/srflx selection while still permitting turn:...?transport=tcp fallback
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            // Immediately prune TCP TURN once UDP TURN succeeds
            turnPortPrunePolicy = PeerConnection.PortPrunePolicy.PRUNE_BASED_ON_PRIORITY
            iceCandidatePoolSize = 2
            // Mark RTP/UDP packets with DSCP QoS (WMM AC_VI) to prioritize stream over background downloads
            enableDscp = true
            // Dedicated hardware VPU encodes off-CPU; foreground app launch CPU spikes must never throttle video
            enableCpuOveruseDetection = false
            // Never suspend video delivery during transient Wi-Fi jitter
            suspendBelowMinBitrate = false
        }

        val pc = pcf.createPeerConnection(
            rtcConfig,
            object : PeerConnection.Observer {
                override fun onIceCandidate(candidate: IceCandidate?) {
                    val c = candidate ?: return
                    if (activeSessionId != sessionId) return
                    val candType = extractIceCandidateType(c.sdp)
                    Log.i(TAG, "Local ICE candidate ($sessionId): type=$candType")
                    callbacks.onLocalIceCandidate(
                        sessionId,
                        RtcIceCandidateInit(
                            candidate = c.sdp,
                            sdpMid = c.sdpMid,
                            sdpMLineIndex = c.sdpMLineIndex,
                        ),
                    )
                }

                override fun onDataChannel(dc: DataChannel?) {
                    if (dc == null || rtcExecutor.isShutdown) return
                    try {
                        rtcExecutor.execute {
                            if (activeSessionId == sessionId) {
                                attachDataChannelOnExecutor(sessionId, dc)
                            } else {
                                disposeDataChannelQuietly(dc)
                            }
                        }
                    } catch (_: Throwable) {
                    }
                }

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                    Log.i(TAG, "WebRTC ICE state ($sessionId): $state")
                    if (activeSessionId != sessionId) return
                    if (state == PeerConnection.IceConnectionState.CONNECTED ||
                        state == PeerConnection.IceConnectionState.COMPLETED
                    ) {
                        if (!rtcExecutor.isShutdown) {
                            try {
                                rtcExecutor.execute {
                                    if (activeSessionId == sessionId) {
                                        val effectiveOverride = if (isActiveRouteTurn || rttCongestionGuard.scale < 1.0) {
                                            val routeMax = LowLatencyEncoderMath.computeRouteMaxBitrateKbps(
                                                resolveTargetBitrateKbps(activeQuality),
                                                isActiveRouteTurn,
                                            )
                                            rttCongestionGuard.applyScale(routeMax, rttCongestionGuard.scale)
                                        } else {
                                            null
                                        }
                                        applyVideoSenderParameters(
                                            videoSender,
                                            activeQuality,
                                            maxKbpsOverride = effectiveOverride,
                                        )
                                        forceCaptureFrameOnExecutor()
                                        startStatsLogger(sessionId)
                                    }
                                }
                            } catch (_: Throwable) {
                            }
                        }
                    } else if (state == PeerConnection.IceConnectionState.FAILED ||
                        state == PeerConnection.IceConnectionState.CLOSED
                    ) {
                        stopStatsLogger()
                        callbacks.onWebRtcDisconnected(sessionId, "ICE $state")
                    }
                }

                override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
                override fun onIceConnectionReceivingChange(receiving: Boolean) {}
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
                    Log.i(TAG, "WebRTC ICE gathering ($sessionId): $state")
                }
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
                override fun onAddStream(stream: MediaStream?) {}
                override fun onRemoveStream(stream: MediaStream?) {}
                override fun onRenegotiationNeeded() {}
                override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
            },
        ) ?: return false

        // Use real-time video mode (`isScreencast = false`) instead of WebRTC's slideshare mode:
        // slideshare mode throttles startup to 360p @ 600kbps and drops scrolling frames aggressively.
        val effectiveFps = resolveTargetFps(quality)
        val source = pcf.createVideoSource(false)
        source.adaptOutputFormat(w, h, effectiveFps)
        val track = pcf.createVideoTrack("velodeck-screen-$sessionId", source)
        track.setEnabled(true)
        val sender = pc.addTrack(track, listOf("velodeck-stream"))
        applyVideoSenderParameters(sender, quality)

        val sth = SurfaceTextureHelper.create("VeloDeckWebRtcCapture", egl.eglBaseContext)
        // Elevate GPU texture capture thread priority so heavy foreground app launches (e.g. Bilibili/QQ)
        // never starve SurfaceTexture frame dispatch
        sth.handler.post {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
            } catch (_: Throwable) {
            }
        }
        sth.setTextureSize(w, h)
        val surface = Surface(sth.surfaceTexture)
        capturedFrameCount.set(0L)
        lastFrameCapturedElapsedMs.set(0L)
        lastRealFrameElapsedMs.set(0L)
        var lastRawSurfaceTsNs = 0L
        var lastDeliveredTsNs = 0L
        source.capturerObserver.onCapturerStarted(true)
        sth.startListening { frame ->
            val count = capturedFrameCount.incrementAndGet()
            val nowElapsedMs = SystemClock.elapsedRealtime()
            lastFrameCapturedElapsedMs.set(nowElapsedMs)
            if (count == 1L) {
                Log.i(TAG, "First WebRTC frame captured (${frame.rotatedWidth}x${frame.rotatedHeight})")
            }
            val rawTsNs = frame.timestampNs
            val isRealFrame = rawTsNs > 0L && rawTsNs != lastRawSurfaceTsNs
            if (isRealFrame) {
                lastRealFrameElapsedMs.set(nowElapsedMs)
            }
            // SurfaceTexture.getTimestamp() uses CLOCK_MONOTONIC (System.nanoTime()), NOT CLOCK_BOOTTIME.
            val nowNs = System.nanoTime()
            val deliveredTsNs = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
                rawTsNs = rawTsNs,
                nowNs = nowNs,
                lastRawSurfaceTsNs = lastRawSurfaceTsNs,
                lastDeliveredTsNs = lastDeliveredTsNs,
            )
            if (isRealFrame) {
                lastRawSurfaceTsNs = rawTsNs
            }
            lastDeliveredTsNs = deliveredTsNs
            val deliveredFrame = if (deliveredTsNs == rawTsNs) {
                frame
            } else {
                VideoFrame(frame.buffer, frame.rotation, deliveredTsNs)
            }
            source.capturerObserver.onFrameCaptured(deliveredFrame)
        }

        if (cancelled.get()) {
            Log.w(TAG, "startSessionOnExecutor($sessionId) aborted due to timeout before attaching surface")
            sth.stopListening()
            source.capturerObserver.onCapturerStopped()
            surface.release()
            sth.dispose()
            track.dispose()
            source.dispose()
            pc.close()
            pc.dispose()
            return false
        }

        if (!captureManager.attachExternalSurface(surface, w, h)) {
            sth.stopListening()
            source.capturerObserver.onCapturerStopped()
            surface.release()
            sth.dispose()
            track.dispose()
            source.dispose()
            pc.close()
            pc.dispose()
            return false
        }

        if (cancelled.get()) {
            Log.w(TAG, "startSessionOnExecutor($sessionId) aborted after attachExternalSurface due to timeout")
            sth.stopListening()
            source.capturerObserver.onCapturerStopped()
            surface.release()
            sth.dispose()
            track.dispose()
            source.dispose()
            pc.close()
            pc.dispose()
            return false
        }

        synchronized(stateLock) {
            activeSessionId = sessionId
            peerConnection = pc
            videoSource = source
            videoTrack = track
            videoSender = sender
            activeQuality = quality
            surfaceTextureHelper = sth
            captureSurface = surface
            remoteDescriptionSet = false
            pendingRemoteIce.clear()
            sessionStartedElapsedMs = SystemClock.elapsedRealtime()
        }
        lastAdaptedWidth = w
        lastAdaptedHeight = h
        captureManager.setExternalResizeListener { handleDisplayConfigChanged() }
        startStaticFramePump(sessionId)

        if (createOfferImmediately) {
            val dc = pc.createDataChannel("control", DataChannel.Init())
            if (dc != null) attachDataChannelOnExecutor(sessionId, dc)
            createLocalOffer(sessionId, pc)
        }
        Log.i(TAG, "WebRTC session ready ($sessionId, ${w}x${h}@${effectiveFps}fps, target=${resolveTargetBitrateKbps(quality)}kbps, iceServers=${rtcIceServers.size})")
        return true
    }

    fun handleRemoteOffer(sessionId: String, sdp: String) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                val pc = synchronized(stateLock) {
                    if (activeSessionId != sessionId) return@synchronized null
                    val activePc = peerConnection ?: return@synchronized null
                    // Reset before setRemoteDescription so ICE restart candidates arriving while
                    // setRemoteDescription runs asynchronously on signaling_thread are queued in
                    // pendingRemoteIce and flushed cleanly instead of dropped against the old ufrag.
                    remoteDescriptionSet = false
                    activePc
                } ?: return@execute

                Log.i(TAG, "Handling remote WebRTC offer ($sessionId, sdpLen=${sdp.length})")
                val tunedRemoteSdp = injectSdpBitrateHints(sdp, activeQuality)
                val remoteDesc = SessionDescription(SessionDescription.Type.OFFER, tunedRemoteSdp)
                pc.setRemoteDescription(
                    SimpleSdpObserver("setRemoteOffer") {
                        // Runs on signaling_thread — dispatch all follow-up work to rtcExecutor!
                        if (rtcExecutor.isShutdown) return@SimpleSdpObserver
                        try {
                            rtcExecutor.execute {
                                if (activeSessionId != sessionId || peerConnection !== pc) return@execute
                                flushPendingIceCandidates(sessionId, pc)
                                pc.createAnswer(
                                    object : SdpObserver {
                                        override fun onCreateSuccess(answer: SessionDescription?) {
                                            val ans = answer ?: return
                                            if (rtcExecutor.isShutdown) return
                                            try {
                                                rtcExecutor.execute {
                                                    if (activeSessionId != sessionId || peerConnection !== pc) return@execute
                                                    pc.setLocalDescription(
                                                        SimpleSdpObserver("setLocalAnswer") {
                                                            Log.i(TAG, "Local WebRTC answer set ($sessionId, sdpLen=${ans.description.length})")
                                                            callbacks.onLocalAnswer(sessionId, ans.description)
                                                            if (!rtcExecutor.isShutdown) {
                                                                try {
                                                                    rtcExecutor.execute {
                                                                        if (activeSessionId == sessionId) {
                                                                            applyVideoSenderParameters(videoSender, activeQuality)
                                                                        }
                                                                    }
                                                                } catch (_: Throwable) {
                                                                }
                                                            }
                                                        },
                                                        ans,
                                                    )
                                                }
                                            } catch (_: Throwable) {
                                            }
                                        }

                                        override fun onSetSuccess() {}
                                        override fun onCreateFailure(err: String?) {
                                            Log.e(TAG, "createAnswer failed ($sessionId): $err")
                                        }

                                        override fun onSetFailure(err: String?) {}
                                    },
                                    MediaConstraints(),
                                )
                            }
                        } catch (_: Throwable) {
                        }
                    },
                    remoteDesc,
                )
            }
        } catch (_: Throwable) {
        }
    }

    fun handleRemoteAnswer(sessionId: String, sdp: String) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                val pc = synchronized(stateLock) {
                    if (activeSessionId != sessionId) null else peerConnection
                } ?: return@execute

                val tunedRemoteSdp = injectSdpBitrateHints(sdp, activeQuality)
                val remoteDesc = SessionDescription(SessionDescription.Type.ANSWER, tunedRemoteSdp)
                pc.setRemoteDescription(
                    SimpleSdpObserver("setRemoteAnswer") {
                        if (rtcExecutor.isShutdown) return@SimpleSdpObserver
                        try {
                            rtcExecutor.execute {
                                if (activeSessionId != sessionId || peerConnection !== pc) return@execute
                                flushPendingIceCandidates(sessionId, pc)
                                applyVideoSenderParameters(videoSender, activeQuality)
                            }
                        } catch (_: Throwable) {
                        }
                    },
                    remoteDesc,
                )
            }
        } catch (_: Throwable) {
        }
    }

    fun addRemoteIceCandidate(sessionId: String, candidate: RtcIceCandidateInit) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                val pcToAdd: PeerConnection? = synchronized(stateLock) {
                    if (activeSessionId != sessionId) return@synchronized null
                    val pc = peerConnection ?: return@synchronized null
                    if (!remoteDescriptionSet) {
                        pendingRemoteIce.add(candidate)
                        return@synchronized null
                    }
                    pc
                }
                if (pcToAdd != null) {
                    val candType = extractIceCandidateType(candidate.candidate)
                    Log.i(TAG, "Adding remote ICE candidate ($sessionId): type=$candType")
                    pcToAdd.addIceCandidate(
                        IceCandidate(
                            candidate.sdpMid ?: "0",
                            candidate.sdpMLineIndex ?: 0,
                            candidate.candidate,
                        ),
                    )
                }
            }
        } catch (_: Throwable) {
        }
    }

    private fun flushPendingIceCandidates(sessionId: String, pc: PeerConnection) {
        val queued = synchronized(stateLock) {
            if (activeSessionId != sessionId || peerConnection !== pc) return
            remoteDescriptionSet = true
            val list = pendingRemoteIce.toList()
            pendingRemoteIce.clear()
            list
        }
        if (queued.isNotEmpty()) {
            Log.i(TAG, "Flushing ${queued.size} queued remote ICE candidates ($sessionId)")
        }
        queued.forEach { candidate ->
            pc.addIceCandidate(
                IceCandidate(
                    candidate.sdpMid ?: "0",
                    candidate.sdpMLineIndex ?: 0,
                    candidate.candidate,
                ),
            )
        }
    }

    fun updateQuality(quality: StreamQuality) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                val (src, sth, surf, sender) = synchronized(stateLock) {
                    activeQuality = quality
                    Quad(videoSource, surfaceTextureHelper, captureSurface, videoSender)
                }
                resetAdaptiveRateState(resetStatsTick = false)
                if (src == null || sth == null || surf == null) return@execute
                val (w, h) = captureManager.computeTargetDimensions(quality.maxWidth)
                lastAdaptedWidth = w
                lastAdaptedHeight = h
                sth.setTextureSize(w, h)
                src.adaptOutputFormat(w, h, resolveTargetFps(quality))
                applyVideoSenderParameters(sender, quality)
                captureManager.attachExternalSurface(surf, w, h)
                encoderFactory?.requestSyncFrame()
                forceCaptureFrameOnExecutor()
            }
        } catch (_: Throwable) {
        }
    }

    fun handleDisplayConfigChanged() {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                val (sid, quality, src, sth, surf) = synchronized(stateLock) {
                    Quint(activeSessionId, activeQuality, videoSource, surfaceTextureHelper, captureSurface)
                }
                if (sid == null || src == null || sth == null || surf == null) return@execute
                val (w, h) = captureManager.computeTargetDimensions(quality.maxWidth)
                if (w == lastAdaptedWidth && h == lastAdaptedHeight) {
                    return@execute
                }
                lastAdaptedWidth = w
                lastAdaptedHeight = h
                sth.setTextureSize(w, h)
                src.adaptOutputFormat(w, h, resolveTargetFps(quality))
                captureManager.attachExternalSurface(surf, w, h)
                Log.i(TAG, "Adapted WebRTC capture surface after orientation/content resize (${w}x${h})")
            }
        } catch (_: Throwable) {
        }
    }

    private fun resolveTargetFps(quality: StreamQuality): Int {
        // Automatically unlock 60fps for 720p+ interactive streams even if an older controller requests 30fps
        val boosted = if (quality.maxWidth >= 720 && quality.fps in 24..30) 60 else quality.fps
        return boosted.coerceIn(24, 60)
    }

    private fun resolveTargetBitrateKbps(quality: StreamQuality): Int {
        // Generous crisp bitrates paired with Constrained High (CABAC + 8x8 DCT) & clamped PTS
        // keep small UI text sharp at 60fps without triggering idle-gap IDR spikes.
        return when {
            quality.maxWidth >= 1080 -> quality.bitrateKbps.coerceIn(4_500, 8_000)
            quality.maxWidth >= 800 -> quality.bitrateKbps.coerceIn(3_000, 5_500)
            quality.maxWidth >= 720 -> quality.bitrateKbps.coerceIn(2_400, 4_200)
            else -> quality.bitrateKbps.coerceIn(900, 1_800)
        }
    }

    /**
     * Injects `x-google-start-bitrate`, `x-google-min-bitrate`, `x-google-max-bitrate`, and `b=AS`
     * into the remote video SDP so libwebrtc's SendSideCongestionController & encoder immediately
     * start at the active preset bitrate while keeping a 10000 kbps session ceiling so mid-session
     * ECO -> BALANCED -> HD upgrades are never permanently capped by the initial SDP.
     */
    private fun injectSdpBitrateHints(sdp: String, quality: StreamQuality): String {
        val presetMaxKbps = resolveTargetBitrateKbps(quality)
        val startKbps = LowLatencyEncoderMath.computeSdpStartBitrateKbps(presetMaxKbps)
        val minKbps = LowLatencyEncoderMath.computeSdpMinBitrateKbps(presetMaxKbps)
        return Companion.injectSdpBitrateHints(
            sdp = sdp,
            minKbps = minKbps,
            startKbps = startKbps,
            sessionCeilingKbps = SDP_SESSION_MAX_BITRATE_KBPS,
        )
    }

    private fun applyVideoSenderParameters(
        sender: RtpSender?,
        quality: StreamQuality,
        maxKbpsOverride: Int? = null,
    ): Boolean {
        if (sender == null) return false
        return try {
            val params = sender.parameters ?: return false
            // Match ScalingSettings.OFF cleanly: bitrate floors (300-500k) + QP_P_MAX=46 adapt
            // smoothly on WAN/TURN without resolution reinit glitches or FPS collapses.
            params.degradationPreference = RtpParameters.DegradationPreference.DISABLED
            val presetMaxKbps = resolveTargetBitrateKbps(quality)
            val maxKbps = (maxKbpsOverride ?: presetMaxKbps).coerceAtLeast(300)
            val maxBps = maxKbps * 1_000
            // Adaptive 15% floor (300-600 kbps) clamped <= maxKbps so minBitrateBps <= maxBitrateBps ALWAYS holds
            val minKbps = minOf(LowLatencyEncoderMath.computeSdpMinBitrateKbps(presetMaxKbps), maxKbps)
            val minBps = minKbps * 1_000
            val maxFps = resolveTargetFps(quality)
            for (encoding in params.encodings) {
                encoding.maxBitrateBps = maxBps
                encoding.minBitrateBps = minBps
                encoding.maxFramerate = maxFps
                encoding.scaleResolutionDownBy = 1.0
                encoding.bitratePriority = 2.0
                encoding.networkPriority = 3
            }
            sender.parameters = params
            lastAppliedMaxBitrateKbps = maxKbps
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to apply video sender parameters", t)
            false
        }
    }

    private fun startStaticFramePump(sessionId: String) {
        stopStaticFramePump()
        val pump = object : Runnable {
            override fun run() {
                if (activeSessionId != sessionId || rtcExecutor.isShutdown) {
                    return
                }
                val now = SystemClock.elapsedRealtime()
                val ageMs = now - sessionStartedElapsedMs
                val sinceLastFrameMs = now - lastFrameCapturedElapsedMs.get()
                val lastRealMs = lastRealFrameElapsedMs.get()
                val sinceLastRealFrameMs = if (lastRealMs > 0L) now - lastRealMs else Long.MAX_VALUE
                val intervalMs = LowLatencyEncoderMath.computeStaticPumpIntervalMs(
                    sessionAgeMs = ageMs,
                    sinceLastRealFrameMs = sinceLastRealFrameMs,
                )
                if (sinceLastFrameMs >= intervalMs) {
                    try {
                        rtcExecutor.execute {
                            if (activeSessionId == sessionId) {
                                forceCaptureFrameOnExecutor(skipIfTextureInUse = true)
                            }
                        }
                    } catch (_: Throwable) {
                    }
                }
                if (activeSessionId == sessionId) {
                    mainHandler.postDelayed(this, LowLatencyEncoderMath.STATIC_PUMP_FAST_INTERVAL_MS)
                }
            }
        }
        framePumpRunnable = pump
        mainHandler.postDelayed(pump, LowLatencyEncoderMath.STATIC_PUMP_FAST_INTERVAL_MS)
    }

    private fun stopStaticFramePump() {
        val old = framePumpRunnable
        framePumpRunnable = null
        if (old != null) {
            mainHandler.removeCallbacks(old)
        }
    }

    private fun startStatsLogger(sessionId: String) {
        if (statsLogRunnable != null && statsLogSessionId == sessionId) {
            return
        }
        stopStatsLogger()
        statsLogSessionId = sessionId
        lastStatsBytesSent = 0L
        lastStatsTimestampMs = SystemClock.elapsedRealtime()
        statsPollTick = 0
        val task = object : Runnable {
            override fun run() {
                if (activeSessionId != sessionId || rtcExecutor.isShutdown) {
                    return
                }
                try {
                    rtcExecutor.execute {
                        val pc = if (activeSessionId == sessionId) peerConnection else null
                        if (pc != null) {
                            try {
                                pc.getStats { report ->
                                    if (!rtcExecutor.isShutdown) {
                                        try {
                                            rtcExecutor.execute {
                                                if (activeSessionId == sessionId && peerConnection === pc) {
                                                    logPeerConnectionStats(sessionId, report)
                                                }
                                            }
                                        } catch (_: Throwable) {
                                        }
                                    }
                                }
                            } catch (_: Throwable) {
                            }
                        }
                    }
                } catch (_: Throwable) {
                }
                if (activeSessionId == sessionId) {
                    mainHandler.postDelayed(this, STATS_POLL_INTERVAL_MS)
                }
            }
        }
        statsLogRunnable = task
        mainHandler.postDelayed(task, STATS_POLL_INTERVAL_MS)
    }

    private fun stopStatsLogger() {
        val old = statsLogRunnable
        statsLogRunnable = null
        statsLogSessionId = null
        if (old != null) {
            mainHandler.removeCallbacks(old)
        }
    }

    private fun logPeerConnectionStats(sessionId: String, report: org.webrtc.RTCStatsReport) {
        try {
            statsPollTick++
            val map = report.statsMap
            var fps: Any? = null
            var bytesSent = 0L
            var retransmitted: Any? = null
            var qualityLimit: Any? = null
            var encoderImpl: Any? = null
            var width: Any? = null
            var height: Any? = null
            var selectedPairId: String? = null
            var fallbackPairMembers: Map<String, Any>? = null

            for (stat in map.values) {
                val m = stat.members
                when (stat.type) {
                    "outbound-rtp" -> {
                        if (m["kind"] == "video" || m["mediaType"] == "video") {
                            fps = m["framesPerSecond"]
                            bytesSent = (m["bytesSent"] as? Number)?.toLong() ?: 0L
                            retransmitted = m["retransmittedPacketsSent"]
                            qualityLimit = m["qualityLimitationReason"]
                            encoderImpl = m["encoderImplementation"]
                            width = m["frameWidth"]
                            height = m["frameHeight"]
                        }
                    }

                    "transport" -> {
                        val pairId = m["selectedCandidatePairId"] as? String
                        if (!pairId.isNullOrBlank()) {
                            selectedPairId = pairId
                        }
                    }

                    "candidate-pair" -> {
                        val state = m["state"] as? String
                        val nominated = m["nominated"] as? Boolean == true
                        if (state == "succeeded" && nominated) {
                            fallbackPairMembers = m
                        }
                    }
                }
            }

            val selectedPairMembers = selectedPairId?.let { map[it]?.members } ?: fallbackPairMembers
            val rttSec = (selectedPairMembers?.get("currentRoundTripTime") as? Number)?.toDouble()
            val rttMsInt = rttSec?.let { (it * 1000.0).toInt() }
            val rttMs = if (rttMsInt != null) "${rttMsInt}ms" else "--"
            val availOutBps = (selectedPairMembers?.get("availableOutgoingBitrate") as? Number)?.toLong()
            val availOutDesc = if (availOutBps != null) "${availOutBps / 1_000L}kbps" else "--"
            val localCandId = selectedPairMembers?.get("localCandidateId") as? String
            val remoteCandId = selectedPairMembers?.get("remoteCandidateId") as? String

            val localCand = localCandId?.let { map[it]?.members }
            val remoteCand = remoteCandId?.let { map[it]?.members }
            val pairDesc = if (localCand != null && remoteCand != null) {
                val localProto = localCand["protocol"] as? String ?: "?"
                val relayProto = localCand["relayProtocol"] as? String
                val protoTag = if (!relayProto.isNullOrBlank()) {
                    "$localProto/relay:$relayProto"
                } else {
                    localProto
                }
                "${localCand["candidateType"]}[$protoTag](${localCand["ip"] ?: localCand["address"] ?: "?"})" +
                    "->${remoteCand["candidateType"]}(${remoteCand["ip"] ?: remoteCand["address"] ?: "?"})"
            } else {
                "pending"
            }

            // 1-second route-aware ceiling & RTT bufferbloat enforcement (runs on rtcExecutor)
            val hasSelectedCandidates = localCand != null || remoteCand != null
            val turnRelay = if (hasSelectedCandidates) {
                localCand?.get("candidateType") == "relay" || remoteCand?.get("candidateType") == "relay"
            } else {
                isActiveRouteTurn
            }
            val prevScale = rttCongestionGuard.scale
            val scale = if (rttMsInt != null) {
                rttCongestionGuard.onRttSample(rttMsInt)
            } else {
                prevScale
            }
            val quality = activeQuality
            val presetMaxKbps = resolveTargetBitrateKbps(quality)
            val routeMaxKbps = LowLatencyEncoderMath.computeRouteMaxBitrateKbps(presetMaxKbps, turnRelay)
            val effectiveMaxKbps = rttCongestionGuard.applyScale(routeMaxKbps, scale)

            val routeChanged = turnRelay != isActiveRouteTurn
            val prevAppliedMaxKbps = lastAppliedMaxBitrateKbps
            val deltaThresholdKbps = maxOf(100, prevAppliedMaxKbps / 20)
            if (routeChanged || abs(effectiveMaxKbps - prevAppliedMaxKbps) >= deltaThresholdKbps) {
                val applied = applyVideoSenderParameters(
                    sender = videoSender,
                    quality = quality,
                    maxKbpsOverride = effectiveMaxKbps,
                )
                if (applied) {
                    isActiveRouteTurn = turnRelay
                    val routeTag = if (turnRelay) "TURN" else "P2P"
                    val reason = when {
                        routeChanged && turnRelay -> "TURN_CEILING"
                        routeChanged -> "P2P_UNLOCK"
                        scale < prevScale -> "RTT_BACKOFF"
                        scale > prevScale -> "RTT_RECOVERY"
                        else -> "ADAPT"
                    }
                    val baseDesc = rttCongestionGuard.baselineRttMs?.let { "${it}ms" } ?: "--"
                    Log.i(
                        TAG,
                        "Adaptive bitrate ($sessionId): $reason ${prevAppliedMaxKbps}->${effectiveMaxKbps}kbps " +
                            "(route=$routeTag preset=${presetMaxKbps}kbps routeCap=${routeMaxKbps}kbps " +
                            "scale=${"%.2f".format(scale)} rtt=$rttMs base=$baseDesc)",
                    )
                }
            }

            // Log full WebRtcStats summary every 3rd tick (= 3s) so logcat stays quiet
            if (statsPollTick % STATS_LOG_EVERY_N_TICKS == 0) {
                val nowMs = SystemClock.elapsedRealtime()
                val dtMs = (nowMs - lastStatsTimestampMs).coerceAtLeast(1L)
                val kbps = if (bytesSent >= lastStatsBytesSent) {
                    ((bytesSent - lastStatsBytesSent) * 8L) / dtMs
                } else {
                    0L
                }
                lastStatsBytesSent = bytesSent
                lastStatsTimestampMs = nowMs

                val routeTag = if (turnRelay) "TURN" else "P2P"
                Log.i(
                    TAG,
                    "WebRtcStats($sessionId): ${width}x${height} fps=$fps rate=${kbps}kbps cap=${effectiveMaxKbps}kbps " +
                        "bwe=$availOutDesc rtt=$rttMs scale=${"%.2f".format(scale)} route=$routeTag " +
                        "retx=$retransmitted limit=$qualityLimit enc=$encoderImpl pair=$pairDesc",
                )
            }
        } catch (_: Throwable) {
        }
    }

    fun requestKeyframe() {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                encoderFactory?.requestSyncFrame()
                forceCaptureFrameOnExecutor()
            }
        } catch (_: Throwable) {
        }
    }

    private fun forceCaptureFrameOnExecutor(skipIfTextureInUse: Boolean = false) {
        val sth = surfaceTextureHelper ?: return
        try {
            if (skipIfTextureInUse && sth.isTextureInUse) {
                return
            }
            sth.forceFrame()
        } catch (_: Throwable) {
        }
    }

    private fun extractIceCandidateType(sdp: String): String {
        val parts = sdp.split(" ")
        val idx = parts.indexOf("typ")
        return if (idx >= 0 && idx + 1 < parts.size) parts[idx + 1] else "unknown"
    }

    fun sendDataChannelText(text: String): Boolean {
        if (!controlDataChannelOpen || controlDataChannel == null || rtcExecutor.isShutdown) {
            return false
        }
        return try {
            rtcExecutor.execute {
                val dc = controlDataChannel ?: return@execute
                try {
                    if (dc.state() != DataChannel.State.OPEN) {
                        controlDataChannelOpen = false
                        return@execute
                    }
                    val buf = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
                    dc.send(DataChannel.Buffer(buf, false))
                } catch (_: Throwable) {
                }
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun sendFileChannelText(text: String): Boolean {
        if (!fileDataChannelOpen || fileDataChannel == null || rtcExecutor.isShutdown) {
            return false
        }
        return try {
            rtcExecutor.execute {
                val dc = fileDataChannel ?: return@execute
                try {
                    if (dc.state() != DataChannel.State.OPEN) {
                        fileDataChannelOpen = false
                        return@execute
                    }
                    val buf = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
                    dc.send(DataChannel.Buffer(buf, false))
                } catch (_: Throwable) {
                }
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    fun closeSession(sessionId: String? = null) {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                closeSessionOnExecutor(sessionId)
            }
        } catch (_: Throwable) {
        }
    }

    private fun closeSessionOnExecutor(sessionId: String?) {
        if (sessionId == null || activeSessionId == sessionId) {
            closeSessionInternal()
        }
    }

    fun shutdown() {
        if (rtcExecutor.isShutdown) return
        try {
            rtcExecutor.execute {
                closeSessionInternal()
                synchronized(initLock) {
                    try {
                        factory?.dispose()
                    } catch (_: Throwable) {
                    }
                    factory = null
                    encoderFactory = null
                    try {
                        eglBase?.release()
                    } catch (_: Throwable) {
                    }
                    eglBase = null
                    initialized.set(false)
                }
            }
        } catch (_: Throwable) {
        } finally {
            rtcExecutor.shutdown()
        }
    }

    private fun resetAdaptiveRateState(resetStatsTick: Boolean = true) {
        isActiveRouteTurn = false
        rttCongestionGuard.reset()
        lastAppliedMaxBitrateKbps = 0
        if (resetStatsTick) {
            statsPollTick = 0
        }
    }

    private fun closeSessionInternal() {
        stopStaticFramePump()
        stopStatsLogger()
        resetAdaptiveRateState()
        captureManager.setExternalResizeListener(null)
        lastAdaptedWidth = 0
        lastAdaptedHeight = 0
        lastRealFrameElapsedMs.set(0L)
        controlDataChannelOpen = false
        fileDataChannelOpen = false

        val dc: DataChannel?
        val pointerDc: DataChannel?
        val fileDc: DataChannel?
        val sth: SurfaceTextureHelper?
        val src: VideoSource?
        val pc: PeerConnection?
        val track: VideoTrack?
        val surf: Surface?
        synchronized(stateLock) {
            activeSessionId = null
            remoteDescriptionSet = false
            pendingRemoteIce.clear()
            dc = controlDataChannel
            controlDataChannel = null
            pointerDc = pointerDataChannel
            pointerDataChannel = null
            fileDc = fileDataChannel
            fileDataChannel = null
            sth = surfaceTextureHelper
            surfaceTextureHelper = null
            src = videoSource
            videoSource = null
            videoSender = null
            pc = peerConnection
            peerConnection = null
            track = videoTrack
            videoTrack = null
            surf = captureSurface
            captureSurface = null
        }

        // All native JNI disposals run exclusively on rtcExecutor and OUTSIDE any lock!
        disposeDataChannelQuietly(dc)
        disposeDataChannelQuietly(pointerDc)
        disposeDataChannelQuietly(fileDc)
        try {
            sth?.stopListening()
        } catch (_: Throwable) {
        }
        try {
            src?.capturerObserver?.onCapturerStopped()
        } catch (_: Throwable) {
        }
        try {
            pc?.close()
            pc?.dispose()
        } catch (_: Throwable) {
        }
        try {
            track?.dispose()
        } catch (_: Throwable) {
        }
        try {
            src?.dispose()
        } catch (_: Throwable) {
        }
        try {
            surf?.release()
        } catch (_: Throwable) {
        }
        try {
            sth?.dispose()
        } catch (_: Throwable) {
        }
    }

    private fun disposeDataChannelQuietly(dc: DataChannel?) {
        if (dc == null) return
        try {
            dc.unregisterObserver()
        } catch (_: Throwable) {
        }
        try {
            dc.close()
        } catch (_: Throwable) {
        }
        try {
            dc.dispose()
        } catch (_: Throwable) {
        }
    }

    private fun createLocalOffer(sessionId: String, pc: PeerConnection) {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"))
        }
        pc.createOffer(
            object : SdpObserver {
                override fun onCreateSuccess(offer: SessionDescription?) {
                    val sdp = offer ?: return
                    if (rtcExecutor.isShutdown) return
                    try {
                        rtcExecutor.execute {
                            if (activeSessionId != sessionId || peerConnection !== pc) return@execute
                            pc.setLocalDescription(
                                SimpleSdpObserver("setLocalOffer") {
                                    callbacks.onLocalOffer(sessionId, sdp.description)
                                },
                                sdp,
                            )
                        }
                    } catch (_: Throwable) {
                    }
                }

                override fun onSetSuccess() {}
                override fun onCreateFailure(err: String?) {
                    Log.e(TAG, "createOffer failed: $err")
                }

                override fun onSetFailure(err: String?) {}
            },
            constraints,
        )
    }

    private fun attachDataChannelOnExecutor(sessionId: String, dc: DataChannel) {
        val label = try {
            dc.label()
        } catch (_: Throwable) {
            ""
        }
        if (label == FILE_CHANNEL_LABEL) {
            val prev = fileDataChannel
            if (prev != null && prev !== dc) {
                disposeDataChannelQuietly(prev)
            }
            fileDataChannel = dc
            fileDataChannelOpen = try {
                dc.state() == DataChannel.State.OPEN
            } catch (_: Throwable) {
                false
            }
            dc.registerObserver(
                object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previousAmount: Long) {}
                    override fun onStateChange() {
                        val state = try {
                            dc.state()
                        } catch (_: Throwable) {
                            return
                        }
                        if (fileDataChannel === dc) {
                            fileDataChannelOpen = (state == DataChannel.State.OPEN)
                        }
                        Log.i(TAG, "DataChannel($label) state=$state")
                        if (state == DataChannel.State.CLOSED) {
                            callbacks.onFileChannelClosed(sessionId)
                        }
                    }

                    override fun onMessage(buffer: DataChannel.Buffer) {
                        if (fileDataChannel === dc) {
                            fileDataChannelOpen = true
                        }
                        val bytes = ByteArray(buffer.data.remaining())
                        buffer.data.get(bytes)
                        if (buffer.binary) {
                            callbacks.onFileChannelBinary(sessionId, bytes)
                        } else {
                            callbacks.onFileChannelText(sessionId, String(bytes, Charsets.UTF_8))
                        }
                    }
                },
            )
            return
        }

        val isPointerChannel = label == POINTER_CHANNEL_LABEL
        if (isPointerChannel) {
            val prev = pointerDataChannel
            if (prev != null && prev !== dc) {
                disposeDataChannelQuietly(prev)
            }
            pointerDataChannel = dc
        } else {
            val prev = controlDataChannel
            if (prev != null && prev !== dc) {
                disposeDataChannelQuietly(prev)
            }
            controlDataChannel = dc
            controlDataChannelOpen = try {
                dc.state() == DataChannel.State.OPEN
            } catch (_: Throwable) {
                false
            }
        }
        dc.registerObserver(
            object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) {}
                override fun onStateChange() {
                    val state = try {
                        dc.state()
                    } catch (_: Throwable) {
                        return
                    }
                    if (!isPointerChannel && controlDataChannel === dc) {
                        controlDataChannelOpen = (state == DataChannel.State.OPEN)
                    }
                    Log.i(TAG, "DataChannel($label) state=$state")
                }

                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (buffer.binary) return
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    val text = String(bytes, Charsets.UTF_8)
                    callbacks.onDataChannelMessage(sessionId, text)
                }
            },
        )
    }

    private fun buildRtcIceServers(configs: List<IceServerConfig>): List<PeerConnection.IceServer> {
        val effective = if (configs.isNotEmpty()) {
            configs
        } else {
            listOf(
                IceServerConfig(urls = listOf("stun:stun.miwifi.com:3478")),
                IceServerConfig(urls = listOf("stun:stun.chat.bilibili.com:3478")),
            )
        }
        return effective.mapNotNull { cfg ->
            if (cfg.urls.isEmpty()) return@mapNotNull null
            val builder = PeerConnection.IceServer.builder(cfg.urls)
            if (!cfg.username.isNullOrBlank()) builder.setUsername(cfg.username)
            if (!cfg.credential.isNullOrBlank()) builder.setPassword(cfg.credential)
            builder.createIceServer()
        }
    }

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)
    private data class Quint<A, B, C, D, E>(val a: A, val b: B, val c: C, val d: D, val e: E)

    private class SimpleSdpObserver(
        private val op: String,
        private val onSuccess: () -> Unit,
    ) : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {}
        override fun onSetSuccess() = onSuccess()
        override fun onCreateFailure(err: String?) {
            Log.e(TAG, "$op createFailure: $err")
        }

        override fun onSetFailure(err: String?) {
            Log.e(TAG, "$op setFailure: $err")
        }
    }

    companion object {
        private const val TAG = "WebRtcSessionManager"
        private const val POINTER_CHANNEL_LABEL = "pointer"
        private const val FILE_CHANNEL_LABEL = "file"
        private const val START_SESSION_TIMEOUT_SEC = 4L
        private const val STATS_POLL_INTERVAL_MS = 1_000L
        private const val STATS_LOG_EVERY_N_TICKS = 3
        internal const val SDP_SESSION_MAX_BITRATE_KBPS = 10_000
        private const val WEBRTC_FIELD_TRIALS =
            "WebRTC-VideoRateControl/pacing_factor:1.25,alr_probing:false/" +
                "WebRTC-CongestionWindow/QueueSize:120,MinBitrate:30000,DropFrame:true/"

        /**
         * Injects `x-google-min-bitrate`, `x-google-start-bitrate`, `x-google-max-bitrate`, and
         * a single `b=AS:` line into the `m=video` section of an SDP without ever creating
         * duplicate `b=AS:` lines when one already follows `c=`.
         */
        internal fun injectSdpBitrateHints(
            sdp: String,
            minKbps: Int,
            startKbps: Int,
            sessionCeilingKbps: Int = SDP_SESSION_MAX_BITRATE_KBPS,
        ): String {
            val normalized = sdp.replace("\r\n", "\n").replace("\r", "\n")
            val lines = normalized.split("\n").toMutableList()
            var inVideo = false
            var videoLineIdx = -1
            val videoPayloadTypes = mutableSetOf<String>()

            for (i in lines.indices) {
                val line = lines[i]
                if (line.startsWith("m=video ")) {
                    inVideo = true
                    videoLineIdx = i
                    line.split(" ").drop(3).forEach { videoPayloadTypes.add(it) }
                } else if (line.startsWith("m=")) {
                    inVideo = false
                } else if (inVideo && line.startsWith("a=fmtp:")) {
                    val pt = line.substringAfter("a=fmtp:").substringBefore(" ").trim()
                    if (pt in videoPayloadTypes && !line.contains("x-google-start-bitrate") && !line.contains("apt=")) {
                        lines[i] = "$line;x-google-min-bitrate=$minKbps;x-google-start-bitrate=$startKbps;x-google-max-bitrate=$sessionCeilingKbps"
                    }
                }
            }

            if (videoLineIdx >= 0) {
                // Scan the entire m=video section first for any existing b=AS: line before inserting after c=
                var videoSectionEnd = videoLineIdx + 1
                var firstAsIdx = -1
                var insertAfterCIdx = -1
                while (videoSectionEnd < lines.size && !lines[videoSectionEnd].startsWith("m=")) {
                    val line = lines[videoSectionEnd]
                    if (line.startsWith("b=AS:") && firstAsIdx < 0) {
                        firstAsIdx = videoSectionEnd
                    } else if (line.startsWith("c=") && insertAfterCIdx < 0) {
                        insertAfterCIdx = videoSectionEnd + 1
                    }
                    videoSectionEnd++
                }
                if (firstAsIdx >= 0) {
                    lines[firstAsIdx] = "b=AS:$sessionCeilingKbps"
                    for (idx in (videoSectionEnd - 1) downTo (firstAsIdx + 1)) {
                        if (lines[idx].startsWith("b=AS:")) {
                            lines.removeAt(idx)
                        }
                    }
                } else {
                    val insertAt = if (insertAfterCIdx >= 0) insertAfterCIdx else (videoLineIdx + 1)
                    lines.add(insertAt.coerceAtMost(lines.size), "b=AS:$sessionCeilingKbps")
                }
            }
            return lines.joinToString("\r\n")
        }
    }
}
