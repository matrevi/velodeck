package com.velodeck.agent.network

import android.content.Context
import android.util.Log
import com.velodeck.agent.protocol.DeviceSummary
import com.velodeck.agent.protocol.ErrorCode
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.storage.AgentConfigStore
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.cio.CIOApplicationEngine
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.request.path
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.pingPeriod
import io.ktor.server.websocket.timeout
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration.Companion.seconds

/**
 * Per-IP and global authentication failure rate limiter for [DirectServer].
 * Locks out for [lockoutMs] (5 minutes) after [maxFailures] (5) failed attempts within [windowMs] (60 seconds).
 */
class DirectAuthRateLimiter(
    private val maxFailures: Int = DEFAULT_MAX_FAILURES,
    private val windowMs: Long = DEFAULT_WINDOW_MS,
    private val lockoutMs: Long = DEFAULT_LOCKOUT_MS,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = Any()
    private val failuresByIp = HashMap<String, ArrayDeque<Long>>()
    private val lockedUntilByIp = HashMap<String, Long>()
    private val globalFailures = ArrayDeque<Long>()
    private var globalLockedUntilMs: Long = 0L

    fun isLockedOut(ip: String): Boolean = synchronized(lock) {
        val now = clockMs()
        if (now < globalLockedUntilMs) return true
        val ipLock = lockedUntilByIp[ip]
        if (ipLock != null) {
            if (now < ipLock) return true
            lockedUntilByIp.remove(ip)
        }
        false
    }

    /** Records an auth failure for [ip] and returns `true` if a lockout is now active. */
    fun recordFailure(ip: String): Boolean = synchronized(lock) {
        val now = clockMs()
        val cutoff = now - windowMs

        // Per-IP tracking
        val ipQueue = failuresByIp.getOrPut(ip) { ArrayDeque() }
        while (ipQueue.isNotEmpty() && ipQueue.first() < cutoff) {
            ipQueue.removeFirst()
        }
        ipQueue.addLast(now)
        if (ipQueue.size >= maxFailures) {
            lockedUntilByIp[ip] = now + lockoutMs
            ipQueue.clear()
        }

        // Global tracking (prevents distributed / rotated-IP brute force)
        while (globalFailures.isNotEmpty() && globalFailures.first() < cutoff) {
            globalFailures.removeFirst()
        }
        globalFailures.addLast(now)
        if (globalFailures.size >= maxFailures) {
            globalLockedUntilMs = now + lockoutMs
            globalFailures.clear()
        }

        // Prune stale map entries opportunistically
        if (failuresByIp.size > 128) {
            failuresByIp.entries.removeIf { it.value.isEmpty() || it.value.last() < cutoff }
        }
        if (lockedUntilByIp.size > 128) {
            lockedUntilByIp.entries.removeIf { it.value <= now }
        }

        now < globalLockedUntilMs || (lockedUntilByIp[ip] ?: 0L) > now
    }

    fun resetIp(ip: String) = synchronized(lock) {
        failuresByIp.remove(ip)
        lockedUntilByIp.remove(ip)
    }

    companion object {
        const val DEFAULT_MAX_FAILURES = 5
        const val DEFAULT_WINDOW_MS = 60_000L
        const val DEFAULT_LOCKOUT_MS = 300_000L
    }
}

/**
 * Embedded Direct-Mode HTTP + WebSocket server listening on `0.0.0.0:<port>` (default 8765).
 *
 * - `GET /health`: Minimal unauthenticated liveness JSON (`{"ok":true,"mode":"direct"}`)
 * - `WS /ws`: Origin-validated `@velodeck/protocol` endpoint requiring full high-entropy `accessToken`
 *   with per-IP & global brute-force lockout protection.
 * - `GET /...`: Serves the bundled Controller PWA from `assets/web/` with SPA fallback, or an
 *   HTML-escaped built-in status page if `assets/web/index.html` is not yet bundled.
 */
class DirectServer(
    context: Context,
    private val configStore: AgentConfigStore,
    private val coordinator: SessionCoordinator,
    private val deviceSummaryProvider: () -> DeviceSummary,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val rateLimiter = DirectAuthRateLimiter()

    private var server: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>? = null
    private var currentPort: Int = -1
    private val clients = ConcurrentHashMap<String, DirectClientSink>()

    private val _runningFlow = MutableStateFlow(false)
    val runningFlow: StateFlow<Boolean> = _runningFlow.asStateFlow()

    private class DirectClientSink(
        override val sinkId: String,
        private val wsSession: DefaultWebSocketServerSession,
        private val scope: CoroutineScope,
    ) : SessionSink {
        override val isDirect: Boolean = true
        private val openFlag = AtomicBoolean(true)
        private val queuedBinaryFrames = AtomicInteger(0)
        override val isOpen: Boolean
            get() = openFlag.get() && wsSession.isActive
        override val canAcceptBinary: Boolean
            get() = isOpen && queuedBinaryFrames.get() < MAX_QUEUED_BINARY_FRAMES

        // Separate channels so control JSON messages are never dropped by video frame backpressure
        private val textChannel = Channel<String>(capacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
        private val binaryChannel = Channel<ByteArray>(capacity = MAX_QUEUED_BINARY_FRAMES)

        private val textJob = scope.launch {
            for (msg in textChannel) {
                try {
                    wsSession.send(Frame.Text(msg))
                } catch (_: Throwable) {
                    close()
                    break
                }
            }
        }

        private val binaryJob = scope.launch {
            for (bytes in binaryChannel) {
                try {
                    wsSession.send(Frame.Binary(true, bytes))
                } catch (_: Throwable) {
                    close()
                    break
                } finally {
                    queuedBinaryFrames.decrementAndGet()
                }
            }
        }

        override fun sendText(text: String): Boolean {
            if (!isOpen) return false
            return textChannel.trySend(text).isSuccess
        }

        override fun sendBinary(bytes: ByteArray): Boolean {
            if (!isOpen) return false
            if (queuedBinaryFrames.get() >= MAX_QUEUED_BINARY_FRAMES) return false
            queuedBinaryFrames.incrementAndGet()
            if (!binaryChannel.trySend(bytes).isSuccess) {
                queuedBinaryFrames.decrementAndGet()
                return false
            }
            return true
        }

        fun disconnectWithReason(code: Short, reason: String) {
            close()
            scope.launch {
                try {
                    wsSession.close(CloseReason(code, reason))
                } catch (_: Throwable) {
                }
            }
        }

        fun close() {
            if (openFlag.compareAndSet(true, false)) {
                textChannel.close()
                binaryChannel.close()
                textJob.cancel()
                binaryJob.cancel()
            }
        }
    }

    fun start(port: Int) {
        if (server != null && currentPort == port && _runningFlow.value) return
        stop()

        val safePort = port.coerceIn(1024, 65535)
        try {
            val engine = embeddedServer(CIO, host = "0.0.0.0", port = safePort) {
                install(WebSockets) {
                    pingPeriod = 20.seconds
                    timeout = 45.seconds
                    maxFrameSize = 8L * 1024L * 1024L
                }

                routing {
                    get("/health") {
                        val json = JSONObject().apply {
                            put("ok", true)
                            put("mode", "direct")
                        }
                        call.respondText(json.toString(), ContentType.Application.Json)
                    }

                    webSocket("/ws") {
                        handleDirectWebSocket(this)
                    }

                    get("{...}") {
                        val reqPath = call.request.path().trimStart('/')
                        val assetRel = if (reqPath.isEmpty()) "index.html" else reqPath

                        // Prevent directory traversal
                        if (assetRel.contains("..")) {
                            call.respondText("Bad Request", status = HttpStatusCode.BadRequest)
                            return@get
                        }

                        val directBytes = readWebAsset(assetRel)
                        if (directBytes != null) {
                            call.response.headers.append(
                                HttpHeaders.CacheControl,
                                cacheControlForPath(assetRel),
                            )
                            call.respondBytes(directBytes, contentTypeForPath(assetRel))
                            return@get
                        }

                        // SPA fallback for client routes (e.g. /device/123)
                        if (!assetRel.contains('.')) {
                            val indexBytes = readWebAsset("index.html")
                            if (indexBytes != null) {
                                call.response.headers.append(
                                    HttpHeaders.CacheControl,
                                    CACHE_CONTROL_NO_STORE,
                                )
                                call.respondBytes(indexBytes, ContentType.Text.Html)
                                return@get
                            }
                        }

                        // Fallback built-in status & quick-connect HTML page if PWA assets aren't bundled yet
                        if (assetRel == "index.html" || !assetRel.contains('.')) {
                            val html = buildFallbackHtml(safePort)
                            call.response.headers.append(
                                HttpHeaders.CacheControl,
                                CACHE_CONTROL_NO_STORE,
                            )
                            call.respondText(html, ContentType.Text.Html)
                        } else {
                            call.respondText("Not Found", status = HttpStatusCode.NotFound)
                        }
                    }
                }
            }

            engine.start(wait = false)
            server = engine
            currentPort = safePort
            _runningFlow.value = true
            Log.i(TAG, "DirectServer started on 0.0.0.0:$safePort")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to start DirectServer on port $safePort", t)
            _runningFlow.value = false
        }
    }

    /**
     * Immediately disconnects every connected Direct WebSocket client with close code `4001`
     * and notifies [SessionCoordinator] so all active sessions are torn down.
     */
    fun revokeAllClients(reason: String) {
        val snapshot = clients.entries.toList()
        clients.clear()
        snapshot.forEach { (sinkId, sink) ->
            sink.disconnectWithReason(4001.toShort(), reason)
            coordinator.onSinkDisconnected(sinkId)
        }
        if (snapshot.isNotEmpty()) {
            Log.i(TAG, "Revoked ${snapshot.size} DirectServer client(s): $reason")
        }
    }

    fun stop() {
        revokeAllClients("server_stopped")
        val s = server
        server = null
        currentPort = -1
        _runningFlow.value = false
        if (s != null) {
            scope.launch(Dispatchers.IO) {
                try {
                    s.stop(gracePeriodMillis = 200L, timeoutMillis = 1_000L)
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun broadcastDeviceStatus(summary: DeviceSummary) {
        if (clients.isEmpty()) return
        val payload = ProtocolCodec.serialize(WireMessage.DeviceStatus(summary))
        clients.values.forEach { sink ->
            if (sink.isOpen) {
                sink.sendText(payload)
            }
        }
    }

    fun shutdown() {
        revokeAllClients("server_shutdown")
        val s = server
        server = null
        currentPort = -1
        _runningFlow.value = false
        scope.cancel()
        if (s != null) {
            // Run on Dispatchers.IO outside the cancelled scope so shutdown never blocks Main
            // and never leaves the listening socket bound.
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    s.stop(gracePeriodMillis = 200L, timeoutMillis = 1_000L)
                } catch (_: Throwable) {
                }
            }
        }
    }

    private suspend fun handleDirectWebSocket(ws: DefaultWebSocketServerSession) {
        val originHeader = ws.call.request.headers[HttpHeaders.Origin]
        val hostHeader = ws.call.request.headers[HttpHeaders.Host]
        if (!isAllowedDirectOrigin(originHeader, hostHeader)) {
            Log.w(TAG, "Rejected Direct WS upgrade with disallowed Origin")
            ws.close(CloseReason(4003.toShort(), "FORBIDDEN_ORIGIN"))
            return
        }

        val clientIp = try {
            ws.call.request.local.remoteAddress.ifBlank { "unknown" }
        } catch (_: Throwable) {
            "unknown"
        }

        val sinkId = "direct-${UUID.randomUUID().toString().take(8)}"
        val sink = DirectClientSink(sinkId, ws, scope)
        var authenticated = false

        try {
            for (frame in ws.incoming) {
                if (frame !is Frame.Text) continue
                val raw = frame.readText()
                val msg = try {
                    ProtocolCodec.parse(raw)
                } catch (t: Throwable) {
                    sink.sendText(
                        ProtocolCodec.serialize(
                            WireMessage.Error(ErrorCode.INVALID_MESSAGE, "Invalid JSON: ${t.message}"),
                        ),
                    )
                    continue
                }

                if (msg is WireMessage.Ping) {
                    sink.sendText(ProtocolCodec.serialize(WireMessage.Pong(msg.ts)))
                    continue
                }
                if (msg is WireMessage.Pong) continue

                if (!authenticated) {
                    if (rateLimiter.isLockedOut(clientIp)) {
                        runCatching {
                            ws.send(
                                Frame.Text(
                                    ProtocolCodec.serialize(
                                        WireMessage.Error(
                                            ErrorCode.RATE_LIMITED,
                                            "Too many failed authentication attempts; temporarily locked out",
                                        ),
                                    ),
                                ),
                            )
                        }
                        ws.close(CloseReason(4029.toShort(), "RATE_LIMITED"))
                        return
                    }

                    if (msg !is WireMessage.ControllerAuth) {
                        rateLimiter.recordFailure(clientIp)
                        runCatching {
                            ws.send(
                                Frame.Text(
                                    ProtocolCodec.serialize(
                                        WireMessage.Error(ErrorCode.UNAUTHORIZED, "Expected controller.auth"),
                                    ),
                                ),
                            )
                        }
                        ws.close(CloseReason(4001.toShort(), "UNAUTHORIZED"))
                        return
                    }

                    // Require the full high-entropy accessToken ONLY (short controlPassword disabled on DirectServer)
                    val tokenValid = !msg.accessToken.isNullOrBlank() &&
                        configStore.verifyAccessToken(msg.accessToken)
                    if (!tokenValid) {
                        val locked = rateLimiter.recordFailure(clientIp)
                        val code = if (locked) ErrorCode.RATE_LIMITED else ErrorCode.UNAUTHORIZED
                        val closeCode = if (locked) 4029.toShort() else 4001.toShort()
                        val errMsg = if (locked) {
                            "Too many failed authentication attempts; locked out for 5 minutes"
                        } else {
                            "Invalid access token"
                        }
                        runCatching {
                            ws.send(Frame.Text(ProtocolCodec.serialize(WireMessage.Error(code, errMsg))))
                        }
                        ws.close(CloseReason(closeCode, code.wireValue))
                        return
                    }

                    rateLimiter.resetIp(clientIp)
                    authenticated = true
                    clients[sinkId] = sink
                    val authed = WireMessage.ControllerAuthed(
                        clientId = msg.clientId,
                        serverTime = System.currentTimeMillis(),
                        mode = "direct",
                        authType = "token",
                        devices = listOf(deviceSummaryProvider()),
                        iceServers = coordinator.getEffectiveIceServers(isDirect = true),
                    )
                    sink.sendText(ProtocolCodec.serialize(authed))
                    continue
                }

                coordinator.handleIncomingMessage(msg, sink)
            }
        } catch (t: Throwable) {
            Log.d(TAG, "Direct WebSocket closed ($sinkId): ${t.message}")
        } finally {
            clients.remove(sinkId)
            sink.close()
            coordinator.onSinkDisconnected(sinkId)
        }
    }

    private fun cacheControlForPath(relativePath: String): String {
        val normalized = relativePath.trimStart('/')
        return when {
            normalized == "index.html" ||
                normalized == "sw.js" ||
                normalized.endsWith("/sw.js") ||
                normalized.endsWith(".html") -> CACHE_CONTROL_NO_STORE
            normalized.startsWith("assets/") -> CACHE_CONTROL_IMMUTABLE_ASSETS
            else -> "no-cache"
        }
    }

    private fun readWebAsset(relativePath: String): ByteArray? {
        return try {
            appContext.assets.open("web/$relativePath").use { it.readBytes() }
        } catch (_: IOException) {
            null
        }
    }

    private fun contentTypeForPath(path: String): ContentType {
        return when (path.substringAfterLast('.', "").lowercase()) {
            "html", "htm" -> ContentType.Text.Html
            "js", "mjs" -> ContentType.Application.JavaScript
            "css" -> ContentType.Text.CSS
            "json" -> ContentType.Application.Json
            "webmanifest" -> ContentType.parse("application/manifest+json")
            "svg" -> ContentType.Image.SVG
            "png" -> ContentType.Image.PNG
            "jpg", "jpeg" -> ContentType.Image.JPEG
            "webp" -> ContentType.parse("image/webp")
            "ico" -> ContentType.parse("image/x-icon")
            "woff2" -> ContentType.parse("font/woff2")
            "wasm" -> ContentType.Application.Wasm
            else -> ContentType.Application.OctetStream
        }
    }

    private fun buildFallbackHtml(port: Int): String {
        val summary = deviceSummaryProvider()
        val safeName = NetworkUtils.escapeHtml(summary.name)
        val safeDeviceId = NetworkUtils.escapeHtml(summary.deviceId)
        val projBadge = if (summary.capabilities.mediaProjection) "已就绪" else "未授权"
        val a11yBadge = if (summary.capabilities.accessibility) "已启用" else "未启用"
        return """
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <title>VeloDeck 极控直连代理 — $safeName</title>
              <style>
                body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0b0f17; color:#f3f6fc; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:20px; box-sizing:border-box; }
                .card { max-width:520px; width:100%; background:#131a26; border:1px solid #26324a; border-radius:16px; padding:24px; }
                h1 { margin:0 0 8px; font-size:20px; }
                p { margin:8px 0; color:#9aa8c1; line-height:1.5; font-size:14px; }
                code { background:#1b2436; padding:3px 7px; border-radius:6px; color:#93c5fd; font-size:13px; }
                .row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #1e293b; font-size:14px; }
                .ok { color:#10b981; font-weight:600; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>📱 VeloDeck 极控直连代理在线</h1>
                <p>当前设备已启用直连 WebSocket 服务，可在 VeloDeck 极控 Web 控制台中使用以下信息直接连接：</p>
                <div class="row"><span>设备名称</span><strong>$safeName</strong></div>
                <div class="row"><span>设备 ID</span><code>$safeDeviceId</code></div>
                <div class="row"><span>WebSocket 端点</span><code>ws://&lt;当前IP&gt;:$port/ws</code></div>
                <div class="row"><span>持久化录屏</span><span class="ok">$projBadge</span></div>
                <div class="row"><span>无障碍控制</span><span class="ok">$a11yBadge</span></div>
                <p style="margin-top:16px">提示：在项目根目录运行 <code>pnpm build:controller && node scripts/sync-controller-to-android.mjs</code> 后重新打包 APK，即可通过本地址直接打开内置完整控制端 PWA。</p>
              </div>
            </body>
            </html>
        """.trimIndent()
    }

    companion object {
        private const val TAG = "DirectServer"
        private const val MAX_QUEUED_BINARY_FRAMES = 2
        private const val CACHE_CONTROL_NO_STORE = "no-cache, no-store, must-revalidate"
        private const val CACHE_CONTROL_IMMUTABLE_ASSETS = "public, max-age=31536000, immutable"

        /**
         * Validates the WebSocket `Origin` header to defend against Cross-Site WebSocket Hijacking (CSWSH):
         * - Absent `Origin` is allowed (native apps / non-browser clients).
         * - `capacitor://localhost` and `https://localhost` are allowed (Capacitor mobile apps).
         * - Same-host origins matching the HTTP `Host` header (`http://` or `https://`) are allowed.
         * - All other cross-origin browser pages are rejected.
         */
        fun isAllowedDirectOrigin(origin: String?, hostHeader: String?): Boolean {
            val cleanOrigin = origin?.trim()
            if (cleanOrigin.isNullOrEmpty()) return true

            if (cleanOrigin.equals("capacitor://localhost", ignoreCase = true) ||
                cleanOrigin.equals("https://localhost", ignoreCase = true)
            ) {
                return true
            }

            val cleanHost = hostHeader?.trim()?.takeIf { it.isNotEmpty() } ?: return false
            return try {
                val originUri = URI(cleanOrigin)
                val originScheme = originUri.scheme?.lowercase() ?: return false
                if (originScheme != "http" && originScheme != "https") return false
                val originHost = originUri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return false
                val originPort = if (originUri.port != -1) {
                    originUri.port
                } else if (originScheme == "https") {
                    443
                } else {
                    80
                }

                val hostUri = URI("http://$cleanHost")
                val reqHost = hostUri.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return false
                val reqPort = if (hostUri.port != -1) hostUri.port else 80

                originHost == reqHost && originPort == reqPort
            } catch (_: Throwable) {
                false
            }
        }
    }
}
