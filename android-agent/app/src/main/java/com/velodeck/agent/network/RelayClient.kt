package com.velodeck.agent.network

import android.os.SystemClock
import android.util.Log
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.service.BackoffPolicy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import javax.net.SocketFactory

enum class RelayConnectionState {
    DISABLED,
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    AUTH_ERROR,
}

/**
 * Persistent outbound WebSocket client connecting to the VeloDeck Relay server.
 * Features exponential backoff with jitter ([BackoffPolicy]), 15s JSON ping heartbeat,
 * 35s dead-connection watchdog, bounded backpressure frame dropping, and instant reconnect hooks.
 */
class RelayClient(
    private val registerBuilder: () -> WireMessage.AgentRegister,
    private val coordinator: SessionCoordinator,
    private val onStateChanged: (RelayConnectionState, String?) -> Unit,
    private val onRegistered: (controlCode: String?, ownerUsername: String?) -> Unit = { _, _ -> },
    private val hasAuthTokenProvider: () -> Boolean = { false },
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val backoff = BackoffPolicy(initialDelayMs = 1_000L, maxDelayMs = 30_000L)

    private val okHttp = OkHttpClient.Builder()
        .socketFactory(NoDelaySocketFactory())
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket stays open indefinitely
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val running = AtomicBoolean(false)
    private val lastPongOrActivityMs = AtomicLong(0L)
    private val connectionGen = AtomicLong(0L)

    // Guards activeSocket, reconnectJob, heartbeatJob, backoff, currentUrl, and debounce state.
    // Never hold socketLock across network I/O or external callbacks.
    private val socketLock = Any()

    @Volatile
    private var currentUrl: String = ""

    @Volatile
    private var activeSocket: WebSocket? = null

    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var lastReconnectTriggerElapsedMs: Long = 0L

    private val _stateFlow = MutableStateFlow(RelayConnectionState.DISABLED)
    val stateFlow: StateFlow<RelayConnectionState> = _stateFlow.asStateFlow()

    private val sink = object : SessionSink {
        override val sinkId: String = "relay"
        override val isDirect: Boolean = false
        override val isOpen: Boolean
            get() = activeSocket != null && _stateFlow.value == RelayConnectionState.CONNECTED
        override val canAcceptBinary: Boolean
            get() {
                val ws = activeSocket ?: return false
                return _stateFlow.value == RelayConnectionState.CONNECTED &&
                    ws.queueSize() <= MAX_OUTBOUND_QUEUE_BYTES
            }

        override fun sendText(text: String): Boolean = this@RelayClient.sendText(text)
        override fun sendBinary(bytes: ByteArray): Boolean = this@RelayClient.sendBinary(bytes)
    }

    fun start(relayUrl: String) {
        val trimmed = relayUrl.trim()
        if (trimmed.isEmpty() || (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://"))) {
            stop(RelayConnectionState.DISABLED, "中继地址无效")
            return
        }
        synchronized(socketLock) {
            currentUrl = trimmed
            running.set(true)
            backoff.reset()
            lastReconnectTriggerElapsedMs = 0L
        }
        emitState(RelayConnectionState.CONNECTING, null)
        connectNow()
    }

    fun stop(finalState: RelayConnectionState = RelayConnectionState.DISABLED, note: String? = null) {
        val oldSocket: WebSocket?
        synchronized(socketLock) {
            running.set(false)
            connectionGen.incrementAndGet()
            reconnectJob?.cancel()
            reconnectJob = null
            heartbeatJob?.cancel()
            heartbeatJob = null
            oldSocket = activeSocket
            activeSocket = null
        }
        closeSocketSafely(oldSocket, "client_stop")
        coordinator.onSinkDisconnected(sink.sinkId)
        emitState(finalState, note)
    }

    fun triggerReconnectNow() {
        val now = SystemClock.elapsedRealtime()
        val shouldReconnect = synchronized(socketLock) {
            if (!running.get() || currentUrl.isBlank()) {
                false
            } else if (lastReconnectTriggerElapsedMs > 0L &&
                (now - lastReconnectTriggerElapsedMs) < RECONNECT_DEBOUNCE_MS
            ) {
                false
            } else {
                lastReconnectTriggerElapsedMs = now
                backoff.reset()
                reconnectJob?.cancel()
                reconnectJob = null
                true
            }
        }
        if (!shouldReconnect) return
        connectNow()
    }

    /**
     * Lightweight liveness check used on non-switching link property changes (e.g. DHCP renewal or
     * VPN route updates): sends a Ping on an already connected socket instead of tearing down an
     * active session, and triggers immediate reconnect only when disconnected or send fails.
     */
    fun probeLiveness() {
        if (!running.get() || currentUrl.isBlank()) return
        when (_stateFlow.value) {
            RelayConnectionState.CONNECTED -> {
                val sent = sendText(ProtocolCodec.serialize(WireMessage.Ping(System.currentTimeMillis())))
                if (!sent) {
                    triggerReconnectNow()
                }
            }

            RelayConnectionState.DISCONNECTED -> {
                triggerReconnectNow()
            }

            else -> Unit
        }
    }

    fun sendTelemetry(telemetry: WireMessage.AgentTelemetry): Boolean {
        if (_stateFlow.value != RelayConnectionState.CONNECTED) return false
        return sendText(ProtocolCodec.serialize(telemetry))
    }

    fun sendText(text: String): Boolean {
        val ws = activeSocket ?: return false
        return try {
            ws.send(text)
        } catch (_: Throwable) {
            false
        }
    }

    fun sendBinary(bytes: ByteArray): Boolean {
        val ws = activeSocket ?: return false
        // Backpressure protection: drop frame if outbound buffer exceeds 48 KB (MAX_OUTBOUND_QUEUE_BYTES)
        if (ws.queueSize() > MAX_OUTBOUND_QUEUE_BYTES) {
            return false
        }
        return try {
            ws.send(bytes.toByteString(0, bytes.size))
        } catch (_: Throwable) {
            false
        }
    }

    fun shutdown() {
        stop(RelayConnectionState.DISABLED)
        scope.cancel()
        okHttp.dispatcher.executorService.shutdown()
        okHttp.connectionPool.evictAll()
    }

    private fun connectNow() {
        val url: String
        val gen: Long
        val oldSocket: WebSocket?
        synchronized(socketLock) {
            if (!running.get() || currentUrl.isBlank()) return
            url = currentUrl
            gen = connectionGen.incrementAndGet()
            heartbeatJob?.cancel()
            heartbeatJob = null
            reconnectJob?.cancel()
            reconnectJob = null
            oldSocket = activeSocket
            activeSocket = null
        }
        closeSocketSafely(oldSocket, "reconnect")

        if (_stateFlow.value != RelayConnectionState.AUTH_ERROR) {
            emitState(RelayConnectionState.CONNECTING, null)
        }
        val request = try {
            Request.Builder().url(url).build()
        } catch (t: Throwable) {
            emitState(RelayConnectionState.DISCONNECTED, "URL 格式错误: ${t.message}")
            scheduleReconnect(gen)
            return
        }

        lastPongOrActivityMs.set(System.currentTimeMillis())

        val socketAlreadyFailed = AtomicBoolean(false)
        val ws = okHttp.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    val accepted = synchronized(socketLock) {
                        if (gen != connectionGen.get() || !running.get()) {
                            false
                        } else {
                            activeSocket = webSocket
                            true
                        }
                    }
                    if (!accepted) {
                        closeSocketSafely(webSocket, "stale")
                        return
                    }
                    lastPongOrActivityMs.set(System.currentTimeMillis())
                    val regMsg = registerBuilder()
                    try {
                        webSocket.send(ProtocolCodec.serialize(regMsg))
                    } catch (t: Throwable) {
                        Log.w(TAG, "Failed to send agent.register", t)
                    }
                    startHeartbeat(gen, webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (gen != connectionGen.get()) return
                    lastPongOrActivityMs.set(System.currentTimeMillis())
                    handleIncomingText(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    try {
                        webSocket.close(code, reason)
                    } catch (_: Throwable) {
                    }
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socketAlreadyFailed.set(true)
                    if (gen != connectionGen.get()) return
                    handleSocketGone(gen, "连接关闭 ($code): $reason")
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socketAlreadyFailed.set(true)
                    if (gen != connectionGen.get()) return
                    val msg = t.message ?: response?.message ?: "网络异常"
                    handleSocketGone(gen, msg)
                }
            },
        )
        var closeStaleSocket = false
        synchronized(socketLock) {
            if (gen == connectionGen.get() && running.get() && !socketAlreadyFailed.get()) {
                activeSocket = ws
            } else if (gen != connectionGen.get() || !running.get()) {
                closeStaleSocket = true
            }
        }
        if (closeStaleSocket) {
            closeSocketSafely(ws, "stale")
        }
    }

    private fun handleIncomingText(raw: String) {
        val msg = try {
            ProtocolCodec.parse(raw)
        } catch (t: Throwable) {
            Log.w(TAG, "Ignoring malformed relay message: ${t.message}")
            return
        }

        when (msg) {
            is WireMessage.AgentRegistered -> {
                synchronized(socketLock) {
                    backoff.reset()
                }
                coordinator.updateRelayIceServers(msg.iceServers)
                onRegistered(msg.controlCode, msg.ownerUsername)
                emitState(RelayConnectionState.CONNECTED, null)
                Log.i(TAG, "Registered on Relay server as ${msg.deviceId}")
            }

            is WireMessage.Ping -> {
                sendText(ProtocolCodec.serialize(WireMessage.Pong(msg.ts)))
            }

            is WireMessage.Pong -> {
                lastPongOrActivityMs.set(System.currentTimeMillis())
            }

            is WireMessage.Error -> {
                Log.w(TAG, "Relay error [${msg.code}]: ${msg.message}")
                if (msg.code == com.velodeck.agent.protocol.ErrorCode.DEVICE_SECRET_MISMATCH ||
                    msg.code == com.velodeck.agent.protocol.ErrorCode.UNAUTHORIZED
                ) {
                    val displayMsg = if (
                        msg.code == com.velodeck.agent.protocol.ErrorCode.UNAUTHORIZED &&
                        hasAuthTokenProvider()
                    ) {
                        "账号登录已失效，请重新登录"
                    } else {
                        msg.message
                    }
                    emitState(RelayConnectionState.AUTH_ERROR, displayMsg)
                }
            }

            else -> coordinator.handleIncomingMessage(msg, sink)
        }
    }

    private fun startHeartbeat(gen: Long, ws: WebSocket) {
        synchronized(socketLock) {
            if (gen != connectionGen.get() || !running.get()) return
            heartbeatJob?.cancel()
            heartbeatJob = scope.launch {
                while (isActive && running.get() && gen == connectionGen.get()) {
                    delay(HEARTBEAT_INTERVAL_MS)
                    if (gen != connectionGen.get()) break

                    val idleMs = System.currentTimeMillis() - lastPongOrActivityMs.get()
                    if (idleMs > HEARTBEAT_TIMEOUT_MS) {
                        Log.w(TAG, "Relay heartbeat timeout (${idleMs}ms); forcing reconnect")
                        // Increment connectionGen BEFORE ws.cancel() so onFailure never double-triggers handleSocketGone
                        val nextGen = synchronized(socketLock) {
                            if (gen != connectionGen.get()) return@launch
                            heartbeatJob = null
                            activeSocket = null
                            connectionGen.incrementAndGet()
                        }
                        ws.cancel()
                        finishSocketGoneAfterCleanup(nextGen, "心跳超时，正在重连")
                        break
                    }
                    val sent = sendText(ProtocolCodec.serialize(WireMessage.Ping(System.currentTimeMillis())))
                    if (!sent) {
                        val nextGen = synchronized(socketLock) {
                            if (gen != connectionGen.get()) return@launch
                            heartbeatJob = null
                            activeSocket = null
                            connectionGen.incrementAndGet()
                        }
                        ws.cancel()
                        finishSocketGoneAfterCleanup(nextGen, "发送心跳失败")
                        break
                    }
                }
            }
        }
    }

    private fun handleSocketGone(gen: Long, reason: String) {
        val nextGen = synchronized(socketLock) {
            if (gen != connectionGen.get()) return
            heartbeatJob?.cancel()
            heartbeatJob = null
            activeSocket = null
            connectionGen.incrementAndGet()
        }
        finishSocketGoneAfterCleanup(nextGen, reason)
    }

    private fun finishSocketGoneAfterCleanup(reconnectGen: Long, reason: String) {
        coordinator.onSinkDisconnected(sink.sinkId)

        if (!running.get()) return
        if (_stateFlow.value != RelayConnectionState.AUTH_ERROR) {
            emitState(RelayConnectionState.DISCONNECTED, reason)
        }
        scheduleReconnect(reconnectGen)
    }

    private fun scheduleReconnect(expectedGen: Long) {
        val delayMs: Long
        val attempt: Int
        synchronized(socketLock) {
            if (!running.get() || expectedGen != connectionGen.get()) return
            reconnectJob?.cancel()
            delayMs = backoff.nextDelayMs()
            attempt = backoff.attemptCount
            reconnectJob = scope.launch {
                delay(delayMs)
                val stillExpected = synchronized(socketLock) {
                    running.get() && expectedGen == connectionGen.get()
                }
                if (stillExpected) {
                    connectNow()
                }
            }
        }
        Log.i(TAG, "Scheduling relay reconnect in ${delayMs}ms (attempt=$attempt)")
    }

    private fun closeSocketSafely(ws: WebSocket?, reason: String) {
        if (ws != null) {
            try {
                ws.close(1000, reason)
            } catch (_: Throwable) {
                try {
                    ws.cancel()
                } catch (_: Throwable) {
                }
            }
        }
    }

    private fun emitState(state: RelayConnectionState, message: String?) {
        _stateFlow.value = state
        onStateChanged(state, message)
    }

    private class NoDelaySocketFactory : SocketFactory() {
        private val delegate = getDefault()
        private fun tune(s: Socket): Socket = s.apply {
            try {
                tcpNoDelay = true
            } catch (_: Throwable) {
            }
        }
        override fun createSocket(): Socket = tune(delegate.createSocket())
        override fun createSocket(host: String?, port: Int): Socket = tune(delegate.createSocket(host, port))
        override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket =
            tune(delegate.createSocket(host, port, localHost, localPort))
        override fun createSocket(host: InetAddress?, port: Int): Socket = tune(delegate.createSocket(host, port))
        override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket =
            tune(delegate.createSocket(address, port, localAddress, localPort))
    }

    companion object {
        private const val TAG = "RelayClient"
        private const val HEARTBEAT_INTERVAL_MS = 15_000L
        private const val HEARTBEAT_TIMEOUT_MS = 35_000L
        private const val RECONNECT_DEBOUNCE_MS = 500L
        // Tight backpressure cap (48 KB = 1-2 frames) eliminates multi-second TCP bufferbloat on ws-jpeg fallback
        private const val MAX_OUTBOUND_QUEUE_BYTES = 48L * 1024L
    }
}
