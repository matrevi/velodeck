package com.velodeck.agent.network

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.velodeck.agent.capture.EncodedJpegFrame
import com.velodeck.agent.capture.ScreenCaptureManager
import com.velodeck.agent.capture.WebRtcCallbacks
import com.velodeck.agent.capture.WebRtcSessionManager
import com.velodeck.agent.input.VeloDeckAccessibilityService
import com.velodeck.agent.protocol.BinaryMediaFrame
import com.velodeck.agent.protocol.ControlCommand
import com.velodeck.agent.protocol.ErrorCode
import com.velodeck.agent.protocol.IceServerConfig
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.RemoteKey
import com.velodeck.agent.protocol.RtcIceCandidateInit
import com.velodeck.agent.protocol.StreamQuality
import com.velodeck.agent.protocol.TransportMode
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.service.PowerHelper
import com.velodeck.agent.storage.AgentConfigStore
import com.velodeck.agent.transfer.FileTransferManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

interface SessionSink {
    val sinkId: String
    val isDirect: Boolean
    val isOpen: Boolean
    val canAcceptBinary: Boolean
        get() = isOpen
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
}

/**
 * Unifies remote control sessions coming from both [RelayClient] and [DirectServer].
 * Manages transport negotiation (`webrtc` vs `ws-jpeg`), strict per-sink session ownership,
 * control command execution, frame distribution, and zero-cost idle pausing of [ScreenCaptureManager].
 */
class SessionCoordinator(
    private val context: Context,
    private val configStore: AgentConfigStore,
    private val captureManager: ScreenCaptureManager,
    private val onSessionCountChanged: (Int) -> Unit,
    private val onEnsureProjection: (suspend () -> Boolean)? = null,
    private val onRemoteLockRequested: (() -> Unit)? = null,
    private val onSessionWillStart: (() -> Unit)? = null,
    private val onSetBlackScreen: ((Boolean) -> Boolean)? = null,
    private val onForcePortraitCommand: ((Boolean) -> Boolean)? = null,
) : WebRtcCallbacks {

    private data class ActiveSession(
        val sessionId: String,
        val deviceId: String,
        val transport: TransportMode,
        var quality: StreamQuality,
        val sink: SessionSink,
    )

    private sealed interface ControlDispatch {
        data class Command(
            val msg: WireMessage.ControlCmd,
            val sink: SessionSink?,
            val viaDataChannel: Boolean,
            val receivedUptimeMs: Long = SystemClock.uptimeMillis(),
        ) : ControlDispatch

        data object CancelActiveTouch : ControlDispatch
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val touchChannel = Channel<ControlDispatch>(Channel.UNLIMITED)
    private val sessions = ConcurrentHashMap<String, ActiveSession>()
    private val stateLock = Any()

    init {
        startTouchActor()
    }

    @Volatile
    private var relayIceServers: List<IceServerConfig> = DEFAULT_ICE_SERVERS

    val webRtcManager = WebRtcSessionManager(context, captureManager, this)
    private val fileTransferManager = FileTransferManager(context)

    private val _activeSessionCount = MutableStateFlow(0)
    val activeSessionCount: StateFlow<Int> = _activeSessionCount.asStateFlow()

    val isWebRtcAvailable: Boolean
        get() = webRtcManager.isAvailable

    fun updateRelayIceServers(servers: List<IceServerConfig>) {
        relayIceServers = if (servers.isNotEmpty()) servers else DEFAULT_ICE_SERVERS
    }

    fun getEffectiveIceServers(isDirect: Boolean): List<IceServerConfig> {
        return if (isDirect) DEFAULT_ICE_SERVERS else relayIceServers
    }

    private fun isSessionOwnedBySink(sessionId: String, sink: SessionSink): Boolean {
        if (sessionId.isBlank()) return false
        return sessions[sessionId]?.sink?.sinkId == sink.sinkId
    }

    private fun rejectUnownedSession(sessionId: String, sink: SessionSink, msgType: String) {
        Log.w(TAG, "Rejected $msgType for unowned or unknown session=$sessionId from sink=${sink.sinkId}")
        sink.sendText(
            ProtocolCodec.serialize(
                WireMessage.Error(
                    code = ErrorCode.UNAUTHORIZED,
                    message = "Session is not owned by this connection",
                    sessionId = sessionId.takeIf { it.isNotBlank() },
                    deviceId = configStore.current.deviceId,
                ),
            ),
        )
    }

    fun handleIncomingMessage(message: WireMessage, sink: SessionSink) {
        when (message) {
            is WireMessage.SessionRequest -> handleSessionRequest(message, sink)

            is WireMessage.SessionEnd -> {
                if (!isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                endSession(message.sessionId, notifyPeer = false, reason = message.reason)
            }

            is WireMessage.RtcOffer -> {
                if (!isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                webRtcManager.handleRemoteOffer(message.sessionId, message.sdp)
            }

            is WireMessage.RtcAnswer -> {
                if (!isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                webRtcManager.handleRemoteAnswer(message.sessionId, message.sdp)
            }

            is WireMessage.RtcIce -> {
                if (!isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                webRtcManager.addRemoteIceCandidate(message.sessionId, message.candidate)
            }

            is WireMessage.ControlCmd -> {
                val isSessionlessAllowed = message.sessionId.isBlank() && (
                    message.command is ControlCommand.Wake ||
                        message.command is ControlCommand.Unlock ||
                        message.command is ControlCommand.BlackScreen ||
                        message.command is ControlCommand.ForcePortrait
                    )
                if (!isSessionlessAllowed && !isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                handleControlCmd(message, sink, viaDataChannel = false)
            }

            is WireMessage.ClipboardSync -> {
                if (!isSessionOwnedBySink(message.sessionId, sink)) {
                    rejectUnownedSession(message.sessionId, sink, message.type)
                    return
                }
                scope.launch {
                    VeloDeckAccessibilityService.instance?.executeCommand(
                        ControlCommand.ClipboardSet(message.text),
                    )
                }
            }

            else -> Unit
        }
    }

    private fun handleSessionRequest(req: WireMessage.SessionRequest, sink: SessionSink) {
        val deviceId = configStore.current.deviceId
        if (req.deviceId.isNotBlank() && req.deviceId != deviceId) {
            sink.sendText(
                ProtocolCodec.serialize(
                    WireMessage.Error(
                        code = ErrorCode.SESSION_NOT_FOUND,
                        message = "Unknown deviceId: ${req.deviceId}",
                        sessionId = req.sessionId,
                        deviceId = req.deviceId,
                    ),
                ),
            )
            return
        }

        if (!captureManager.hasProjection) {
            val recover = onEnsureProjection
            if (recover != null) {
                scope.launch {
                    val ok = try {
                        recover()
                    } catch (t: Throwable) {
                        Log.w(TAG, "Auto projection recovery threw", t)
                        false
                    }
                    if (ok && captureManager.hasProjection) {
                        if (sink.isOpen) {
                            startSessionAfterProjectionReady(req, sink, deviceId)
                        }
                    } else {
                        sink.sendText(
                            ProtocolCodec.serialize(
                                WireMessage.Error(
                                    code = ErrorCode.INTERNAL_ERROR,
                                    message = "被控手机尚未授予录屏权限（请开启无障碍或点击手机端「持久录屏授权」）",
                                    sessionId = req.sessionId,
                                    deviceId = deviceId,
                                ),
                            ),
                        )
                    }
                }
                return
            }
            sink.sendText(
                ProtocolCodec.serialize(
                    WireMessage.Error(
                        code = ErrorCode.INTERNAL_ERROR,
                        message = "MediaProjection not yet granted on Android device",
                        sessionId = req.sessionId,
                        deviceId = deviceId,
                    ),
                ),
            )
            return
        }

        startSessionAfterProjectionReady(req, sink, deviceId)
    }

    private fun startSessionAfterProjectionReady(
        req: WireMessage.SessionRequest,
        sink: SessionSink,
        deviceId: String,
    ) {
        val rtcAvailable = req.preferredTransport == TransportMode.WEBRTC && webRtcManager.isAvailable

        var unowned = false
        var wantWebRtc = false
        var replacedWebRtc: List<ActiveSession> = emptyList()
        var initialSession: ActiveSession? = null

        synchronized(stateLock) {
            val existing = sessions[req.sessionId]
            if (existing != null && existing.sink.sinkId != sink.sinkId) {
                unowned = true
            } else {
                // Single VirtualDisplay can serve one WebRTC surface or multiple ws-jpeg subscribers.
                // Prefer WebRTC only when requested, available, and no ws-jpeg session is currently active.
                val hasWsJpegSessions = sessions.values.any {
                    it.sessionId != req.sessionId && it.transport == TransportMode.WS_JPEG
                }
                wantWebRtc = rtcAvailable && !hasWsJpegSessions

                replacedWebRtc = if (wantWebRtc) {
                    sessions.values.filter { it.transport == TransportMode.WEBRTC && it.sessionId != req.sessionId }
                } else {
                    sessions.values.filter { it.transport == TransportMode.WEBRTC }
                }
                replacedWebRtc.forEach { old -> sessions.remove(old.sessionId) }

                val session = ActiveSession(
                    sessionId = req.sessionId,
                    deviceId = deviceId,
                    transport = if (wantWebRtc) TransportMode.WEBRTC else TransportMode.WS_JPEG,
                    quality = req.quality,
                    sink = sink,
                )
                sessions[req.sessionId] = session
                initialSession = session
            }
        }

        if (unowned) {
            rejectUnownedSession(req.sessionId, sink, req.type)
            return
        }
        val createdSession = initialSession ?: return

        // Switch any idle pure-black OLED curtain to transparent stealth-dim & wake screen
        // BEFORE video capture starts so the remote controller never sees a black curtain frame.
        onSessionWillStart?.invoke()

        // Notify and close replaced WebRTC sessions OUTSIDE stateLock for lock-freedom
        val replaceReason = if (wantWebRtc) "replaced_by_new_session" else "replaced_by_ws_jpeg"
        replacedWebRtc.forEach { old ->
            if (old.sessionId != req.sessionId && old.sink.isOpen) {
                old.sink.sendText(
                    ProtocolCodec.serialize(
                        WireMessage.SessionEnd(old.sessionId, deviceId, replaceReason),
                    ),
                )
            }
            fileTransferManager.abortSession(old.sessionId)
            webRtcManager.closeSession(old.sessionId)
        }

        var chosenTransport = createdSession.transport
        if (wantWebRtc) {
            val effectiveIceServers = req.iceServers?.takeIf { it.isNotEmpty() }
                ?: getEffectiveIceServers(sink.isDirect)
            val started = webRtcManager.startSession(
                sessionId = req.sessionId,
                iceServers = effectiveIceServers,
                quality = req.quality,
                createOfferImmediately = false, // Controller creates Offer after session.ready
            )

            var invalidated = false
            synchronized(stateLock) {
                val stillCurrent = sessions[req.sessionId] === createdSession &&
                    sink.isOpen &&
                    captureManager.hasProjection
                if (!stillCurrent) {
                    if (sessions[req.sessionId] === createdSession) {
                        sessions.remove(req.sessionId)
                    }
                    invalidated = true
                } else if (!started) {
                    Log.w(TAG, "WebRTC session failed to start; falling back to ws-jpeg")
                    chosenTransport = TransportMode.WS_JPEG
                    sessions[req.sessionId] = createdSession.copy(transport = TransportMode.WS_JPEG)
                }
            }

            if (invalidated) {
                fileTransferManager.abortSession(req.sessionId)
                if (started) {
                    webRtcManager.closeSession(req.sessionId)
                }
                pauseCaptureIfIdle()
                updateSessionCount()
                return
            }
        }

        val geom = captureManager.getDisplayGeometry()
        sink.sendText(
            ProtocolCodec.serialize(
                WireMessage.SessionReady(
                    sessionId = req.sessionId,
                    deviceId = deviceId,
                    transport = chosenTransport,
                    screenWidth = geom.width,
                    screenHeight = geom.height,
                    rotation = geom.rotation,
                ),
            ),
        )

        if (chosenTransport == TransportMode.WS_JPEG) {
            val stillWsJpeg = synchronized(stateLock) {
                sessions[req.sessionId]?.transport == TransportMode.WS_JPEG
            }
            if (stillWsJpeg) {
                captureManager.startJpegStream(
                    quality = req.quality,
                    canAcceptFrame = {
                        sessions.values.any {
                            it.transport == TransportMode.WS_JPEG && it.sink.canAcceptBinary
                        }
                    },
                ) { frame ->
                    broadcastJpegFrame(frame)
                }
                // Immediately emit cached frame if screen is currently static
                captureManager.requestKeyframe()
            } else {
                pauseCaptureIfIdle()
            }
        }

        updateSessionCount()
    }

    private fun broadcastJpegFrame(frame: EncodedJpegFrame) {
        val jpegSessions = sessions.values.filter { it.transport == TransportMode.WS_JPEG }
        if (jpegSessions.isEmpty()) return

        for (session in jpegSessions) {
            if (!session.sink.isOpen) {
                endSession(session.sessionId, notifyPeer = false, reason = "sink_closed")
                continue
            }
            val encoded = BinaryMediaFrame.encode(
                BinaryMediaFrame.MediaFrame(
                    frameType = BinaryMediaFrame.FRAME_TYPE_JPEG,
                    width = frame.width,
                    height = frame.height,
                    rotation = frame.rotation,
                    keyframe = true,
                    timestampMs = frame.timestampMs,
                    sessionId = session.sessionId,
                    payload = frame.jpegBytes,
                ),
            )
            session.sink.sendBinary(encoded)
        }
    }

    private fun isGestureCommand(cmd: ControlCommand): Boolean = when (cmd) {
        is ControlCommand.Tap,
        is ControlCommand.LongPress,
        is ControlCommand.Swipe,
        is ControlCommand.TouchDown,
        is ControlCommand.TouchMove,
        is ControlCommand.TouchUp,
        is ControlCommand.Pinch,
        -> true
        else -> false
    }

    /**
     * Single sequential consumer for all touch/gesture commands so packet arrival order is
     * strictly preserved (`TouchUp` can never overtake `TouchDown`), out-of-order `TouchMove`
     * packets are rejected by monotonic `seq`, and backlogged consecutive `TouchMove` packets
     * for the same pointer are coalesced to the highest `seq`.
     */
    private fun startTouchActor() {
        scope.launch {
            var pendingNext: ControlDispatch? = null
            val lastTouchMoveSeqByPointer = mutableMapOf<Int, Int>()
            while (true) {
                val first = pendingNext ?: touchChannel.receiveCatching().getOrNull() ?: break
                pendingNext = null

                when (first) {
                    is ControlDispatch.CancelActiveTouch -> {
                        lastTouchMoveSeqByPointer.clear()
                        try {
                            VeloDeckAccessibilityService.instance?.cancelActiveTouch()
                        } catch (ce: CancellationException) {
                            throw ce
                        } catch (t: Throwable) {
                            Log.w(TAG, "Failed to cancel active touch stroke", t)
                        }
                    }

                    is ControlDispatch.Command -> {
                        var current: ControlDispatch.Command = first
                        var skipExecution = false
                        val firstCmd = first.msg.command
                        when (firstCmd) {
                            is ControlCommand.TouchDown -> {
                                lastTouchMoveSeqByPointer.clear()
                            }

                            is ControlCommand.TouchUp -> {
                                lastTouchMoveSeqByPointer.remove(firstCmd.pointerId)
                            }

                            is ControlCommand.Pinch -> {
                                lastTouchMoveSeqByPointer.clear()
                            }

                            is ControlCommand.TouchMove -> {
                                val pointerId = firstCmd.pointerId
                                val sessionId = first.msg.sessionId
                                while (true) {
                                    val next = touchChannel.tryReceive().getOrNull() ?: break
                                    if (next is ControlDispatch.Command &&
                                        next.msg.sessionId == sessionId &&
                                        next.msg.command is ControlCommand.TouchMove &&
                                        next.msg.command.pointerId == pointerId
                                    ) {
                                        if (shouldPreferCoalescedTouchMove(current.msg.seq, next.msg.seq)) {
                                            current = next
                                        }
                                    } else {
                                        pendingNext = next
                                        break
                                    }
                                }
                                val lastSeq = lastTouchMoveSeqByPointer[pointerId]
                                if (!shouldAcceptTouchMoveSeq(lastSeq, current.msg.seq)) {
                                    skipExecution = true
                                } else {
                                    current.msg.seq?.let { seq ->
                                        lastTouchMoveSeqByPointer[pointerId] = seq
                                    }
                                }
                            }

                            else -> Unit
                        }
                        if (!skipExecution &&
                            (current.msg.sessionId.isBlank() || sessions.containsKey(current.msg.sessionId))
                        ) {
                            try {
                                executeControlCommand(
                                    msg = current.msg,
                                    sink = current.sink,
                                    viaDataChannel = current.viaDataChannel,
                                    receivedUptimeMs = current.receivedUptimeMs,
                                )
                            } catch (ce: CancellationException) {
                                throw ce
                            } catch (t: Throwable) {
                                Log.w(TAG, "Touch actor command execution failed", t)
                            }
                        }
                    }
                }
            }
        }
    }

    private fun handleControlCmd(
        msg: WireMessage.ControlCmd,
        sink: SessionSink?,
        viaDataChannel: Boolean,
    ) {
        val receivedUptimeMs = SystemClock.uptimeMillis()
        if (isGestureCommand(msg.command)) {
            touchChannel.trySend(ControlDispatch.Command(msg, sink, viaDataChannel, receivedUptimeMs))
            return
        }
        scope.launch {
            executeControlCommand(msg, sink, viaDataChannel, receivedUptimeMs)
        }
    }

    private suspend fun executeControlCommand(
        msg: WireMessage.ControlCmd,
        sink: SessionSink?,
        viaDataChannel: Boolean,
        receivedUptimeMs: Long = SystemClock.uptimeMillis(),
    ) {
        val deviceId = configStore.current.deviceId
        val cmd = msg.command
        val (ok, detail) = when (cmd) {
            is ControlCommand.Quality -> {
                val session = sessions[msg.sessionId]
                session?.quality = cmd.quality
                if (session?.transport == TransportMode.WEBRTC) {
                    webRtcManager.updateQuality(cmd.quality)
                } else {
                    captureManager.updateQuality(cmd.quality)
                }
                true to null
            }

            is ControlCommand.RequestKeyframe -> {
                val session = sessions[msg.sessionId]
                if (session?.transport == TransportMode.WEBRTC) {
                    webRtcManager.requestKeyframe()
                } else {
                    captureManager.requestKeyframe()
                }
                true to null
            }

            is ControlCommand.Wake -> {
                val woke = PowerHelper.wakeScreen(context)
                woke to if (woke) null else "Failed to wake screen"
            }

            is ControlCommand.BlackScreen -> {
                val applied = onSetBlackScreen?.invoke(cmd.enabled) ?: false
                applied to if (applied) null else "伪装黑屏服务未就绪"
            }

            is ControlCommand.ForcePortrait -> {
                val applied = onForcePortraitCommand?.invoke(cmd.enabled) ?: false
                applied to if (applied) null else "强制竖屏服务未就绪"
            }

            else -> {
                val a11y = VeloDeckAccessibilityService.instance
                if (a11y == null) {
                    false to "无障碍控制服务未启用，无法执行远程触控/按键"
                } else {
                    if (cmd is ControlCommand.Key && cmd.key == RemoteKey.LOCK) {
                        onRemoteLockRequested?.invoke()
                    }
                    a11y.executeCommand(
                        command = cmd,
                        configuredPin = configStore.current.unlockPin,
                        eventUptimeMs = receivedUptimeMs,
                    )
                }
            }
        }

        if (!shouldSendControlAck(cmd, ok)) {
            return
        }

        val ack = WireMessage.ControlAck(
            sessionId = msg.sessionId,
            deviceId = deviceId,
            seq = msg.seq,
            ok = ok,
            message = detail,
        )
        val serialized = ProtocolCodec.serialize(ack)
        if (viaDataChannel && webRtcManager.sendDataChannelText(serialized)) {
            return
        }
        sink?.sendText(serialized) ?: sessions[msg.sessionId]?.sink?.sendText(serialized)
    }

    fun endSession(sessionId: String, notifyPeer: Boolean = false, reason: String? = null) {
        val removed = synchronized(stateLock) {
            sessions.remove(sessionId)
        } ?: return

        touchChannel.trySend(ControlDispatch.CancelActiveTouch)
        fileTransferManager.abortSession(sessionId)
        if (removed.transport == TransportMode.WEBRTC) {
            webRtcManager.closeSession(sessionId)
        }
        if (notifyPeer && removed.sink.isOpen) {
            removed.sink.sendText(
                ProtocolCodec.serialize(
                    WireMessage.SessionEnd(
                        sessionId = sessionId,
                        deviceId = removed.deviceId,
                        reason = reason,
                    ),
                ),
            )
        }
        pauseCaptureIfIdle()
        updateSessionCount()
    }

    /**
     * Immediately terminates every active remote session (e.g., physical owner kill switch),
     * notifies all connected peers, closes WebRTC, and pauses screen capture (clearing frame cache).
     */
    fun disconnectAllSessions(reason: String) {
        val existing: List<ActiveSession>
        synchronized(stateLock) {
            existing = sessions.values.toList()
            sessions.clear()
        }
        if (existing.isNotEmpty()) {
            touchChannel.trySend(ControlDispatch.CancelActiveTouch)
        }
        existing.forEach { s -> fileTransferManager.abortSession(s.sessionId) }
        webRtcManager.closeSession()
        existing.forEach { s ->
            if (s.sink.isOpen) {
                s.sink.sendText(
                    ProtocolCodec.serialize(
                        WireMessage.SessionEnd(s.sessionId, s.deviceId, reason),
                    ),
                )
            }
        }
        pauseCaptureIfIdle()
        updateSessionCount()
    }

    fun onSinkDisconnected(sinkId: String) {
        val toRemove: List<ActiveSession>
        synchronized(stateLock) {
            toRemove = sessions.values.filter { it.sink.sinkId == sinkId }
            toRemove.forEach { sessions.remove(it.sessionId) }
        }
        if (toRemove.isEmpty()) return

        touchChannel.trySend(ControlDispatch.CancelActiveTouch)
        toRemove.forEach { s ->
            fileTransferManager.abortSession(s.sessionId)
            if (s.transport == TransportMode.WEBRTC) {
                webRtcManager.closeSession(s.sessionId)
            }
        }
        pauseCaptureIfIdle()
        updateSessionCount()
    }

    fun onProjectionRevoked() {
        val existing: List<ActiveSession>
        synchronized(stateLock) {
            existing = sessions.values.toList()
            sessions.clear()
        }
        if (existing.isNotEmpty()) {
            touchChannel.trySend(ControlDispatch.CancelActiveTouch)
        }
        existing.forEach { s -> fileTransferManager.abortSession(s.sessionId) }
        webRtcManager.closeSession()
        existing.forEach { s ->
            if (s.sink.isOpen) {
                s.sink.sendText(
                    ProtocolCodec.serialize(
                        WireMessage.SessionEnd(s.sessionId, s.deviceId, "projection_revoked"),
                    ),
                )
            }
        }
        captureManager.pauseStreaming()
        updateSessionCount()
    }

    fun shutdown() {
        synchronized(stateLock) {
            sessions.clear()
        }
        VeloDeckAccessibilityService.instance?.cancelActiveTouchAsync()
        touchChannel.close()
        fileTransferManager.shutdown()
        webRtcManager.shutdown()
        updateSessionCount()
        scope.cancel()
    }

    private fun pauseCaptureIfIdle() {
        val idle = synchronized(stateLock) { sessions.isEmpty() }
        if (idle) {
            // Idle zero-cost pause WITHOUT stopping MediaProjection!
            captureManager.pauseStreaming()
        }
    }

    fun requestActiveKeyframe() {
        val active = sessions.values.toList()
        if (active.any { it.transport == TransportMode.WEBRTC }) {
            webRtcManager.requestKeyframe()
        }
        if (active.any { it.transport == TransportMode.WS_JPEG }) {
            captureManager.requestKeyframe()
        }
    }

    private fun updateSessionCount() {
        val count = synchronized(stateLock) { sessions.size }
        _activeSessionCount.value = count
        onSessionCountChanged(count)
    }

    // --- WebRtcCallbacks ---

    override fun onLocalOffer(sessionId: String, sdp: String) {
        val session = sessions[sessionId] ?: return
        session.sink.sendText(
            ProtocolCodec.serialize(WireMessage.RtcOffer(sessionId, session.deviceId, sdp)),
        )
    }

    override fun onLocalAnswer(sessionId: String, sdp: String) {
        val session = sessions[sessionId] ?: return
        session.sink.sendText(
            ProtocolCodec.serialize(WireMessage.RtcAnswer(sessionId, session.deviceId, sdp)),
        )
    }

    override fun onLocalIceCandidate(sessionId: String, candidate: RtcIceCandidateInit) {
        val session = sessions[sessionId] ?: return
        session.sink.sendText(
            ProtocolCodec.serialize(WireMessage.RtcIce(sessionId, session.deviceId, candidate)),
        )
    }

    override fun onDataChannelMessage(sessionId: String, text: String) {
        if (isDataChannelKeepalive(text)) return
        try {
            val parsed = ProtocolCodec.parse(text)
            if (parsed is WireMessage.ControlCmd) {
                val session = sessions[sessionId] ?: return
                if (parsed.sessionId.isNotBlank() && parsed.sessionId != sessionId) {
                    Log.w(TAG, "Rejected DataChannel control command targeting mismatched session")
                    return
                }
                handleControlCmd(parsed, session.sink, viaDataChannel = true)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to parse DataChannel control message", t)
        }
    }

    override fun onFileChannelText(sessionId: String, text: String) {
        if (!sessions.containsKey(sessionId)) return
        fileTransferManager.handleTextMessage(sessionId, text) { reply ->
            webRtcManager.sendFileChannelText(reply)
        }
    }

    override fun onFileChannelBinary(sessionId: String, bytes: ByteArray) {
        if (!sessions.containsKey(sessionId)) return
        fileTransferManager.handleBinaryChunk(sessionId, bytes) { reply ->
            webRtcManager.sendFileChannelText(reply)
        }
    }

    override fun onFileChannelClosed(sessionId: String) {
        fileTransferManager.abortSession(sessionId)
    }

    override fun onWebRtcDisconnected(sessionId: String, reason: String) {
        Log.w(TAG, "WebRTC disconnected ($sessionId): $reason")
        fileTransferManager.abortSession(sessionId)
        val failedSession = sessions[sessionId] ?: return
        if (failedSession.transport != TransportMode.WEBRTC) return
        // Give the Controller a brief window to fall back cleanly to ws-jpeg; if the same
        // failed WebRTC session is still open after 6s, tear it down so capture/notification recover.
        scope.launch {
            delay(WEBRTC_DISCONNECT_CLEANUP_DELAY_MS)
            val current = sessions[sessionId]
            if (current === failedSession && current.transport == TransportMode.WEBRTC) {
                Log.w(TAG, "Cleaning up stale disconnected WebRTC session=$sessionId after 6s ($reason)")
                endSession(sessionId, notifyPeer = true, reason = "webrtc_disconnected")
            }
        }
    }

    companion object {
        private const val TAG = "SessionCoordinator"
        private const val WEBRTC_DISCONNECT_CLEANUP_DELAY_MS = 6_000L
        val DEFAULT_ICE_SERVERS = listOf(
            IceServerConfig(urls = listOf("stun:stun.miwifi.com:3478")),
            IceServerConfig(urls = listOf("stun:stun.chat.bilibili.com:3478")),
        )

        /**
         * Returns `true` when a `TouchMove` command's sequence number strictly advances past the
         * last executed `TouchMove` for the same pointer (or when either side omits `seq`).
         */
        internal fun shouldAcceptTouchMoveSeq(lastSeq: Int?, candidateSeq: Int?): Boolean {
            if (candidateSeq == null || lastSeq == null) return true
            return candidateSeq > lastSeq
        }

        /**
         * During consecutive `TouchMove` coalescing, always keep the move with the highest `seq`
         * so out-of-order delayed packets can never overwrite newer coordinates.
         */
        internal fun shouldPreferCoalescedTouchMove(currentSeq: Int?, nextSeq: Int?): Boolean {
            if (nextSeq == null) return currentSeq == null
            if (currentSeq == null) return true
            return nextSeq > currentSeq
        }

        /**
         * Suppresses successful `TouchMove` ACKs to avoid flooding SCTP/rtcExecutor with ~50 JSON
         * ACKs/sec while preserving error ACKs and ACKs for all discrete commands.
         */
        internal fun shouldSendControlAck(cmd: ControlCommand, ok: Boolean): Boolean {
            return !(ok && cmd is ControlCommand.TouchMove)
        }

        /**
         * Detects lightweight DataChannel `dc.ping` keepalive frames so they can be ignored
         * silently without throwing `IllegalArgumentException` or spamming warnings, while
         * preserving real `control.cmd` payloads whose text happens to mention `"dc.ping"`.
         */
        internal fun isDataChannelKeepalive(text: String): Boolean {
            if (!text.contains("dc.ping")) return false
            return try {
                JSONObject(text).optString("type") == "dc.ping"
            } catch (_: Throwable) {
                false
            }
        }
    }
}
