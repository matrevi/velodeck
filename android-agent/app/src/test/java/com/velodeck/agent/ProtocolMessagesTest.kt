package com.velodeck.agent

import com.velodeck.agent.network.AccountApiClient
import com.velodeck.agent.network.NetworkUtils
import com.velodeck.agent.network.SessionCoordinator
import com.velodeck.agent.protocol.ControlCommand
import com.velodeck.agent.protocol.DeviceCapabilities
import com.velodeck.agent.protocol.DeviceSummary
import com.velodeck.agent.protocol.IceServerConfig
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.RemoteKey
import com.velodeck.agent.protocol.StreamQuality
import com.velodeck.agent.protocol.TransportMode
import com.velodeck.agent.protocol.UserProfile
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.storage.AgentConfigStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolMessagesTest {

    @Test
    fun parseAndSerialize_controllerAuthAndAuthed() {
        val authJson = """{"type":"controller.auth","accessToken":"tok-123","clientId":"ctrl-1","clientName":"iPhone"}"""
        val parsed = ProtocolCodec.parse(authJson) as WireMessage.ControllerAuth
        assertEquals("tok-123", parsed.accessToken)
        assertEquals("ctrl-1", parsed.clientId)
        assertEquals("iPhone", parsed.clientName)

        val summary = DeviceSummary(
            deviceId = "android-01",
            name = "Pixel 9",
            model = "Google Pixel 9",
            androidVersion = "16",
            online = true,
            lastSeen = 1700000000000L,
            screenWidth = 1080,
            screenHeight = 2424,
            rotation = 0,
            battery = 88,
            charging = true,
            locked = false,
            screenOn = true,
            directUrl = "ws://100.64.0.10:8765/ws",
            capabilities = DeviceCapabilities(
                webrtc = true,
                wsJpeg = true,
                wsH264 = false,
                wake = true,
                unlock = true,
                accessibility = true,
                mediaProjection = true,
            ),
        )
        val authed = WireMessage.ControllerAuthed(
            clientId = "ctrl-1",
            serverTime = 1700000001000L,
            mode = "direct",
            devices = listOf(summary),
            iceServers = listOf(
                IceServerConfig(urls = listOf("stun:stun.miwifi.com:3478")),
                IceServerConfig(
                    urls = listOf("turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp"),
                    username = "u1",
                    credential = "p1",
                ),
            ),
        )
        val roundTripped = ProtocolCodec.parse(ProtocolCodec.serialize(authed)) as WireMessage.ControllerAuthed
        assertEquals("direct", roundTripped.mode)
        assertEquals(1, roundTripped.devices.size)
        assertEquals("android-01", roundTripped.devices.first().deviceId)
        assertEquals(2, roundTripped.iceServers.size)
        assertEquals(2, roundTripped.iceServers[1].urls.size)
        assertEquals("u1", roundTripped.iceServers[1].username)
    }

    @Test
    fun parseAndSerialize_sessionRequestAndReady() {
        val reqJson = """
            {
              "type": "session.request",
              "sessionId": "sess-99",
              "deviceId": "android-01",
              "preferredTransport": "webrtc",
              "quality": {"maxWidth": 900, "fps": 60, "bitrateKbps": 4500, "jpegQuality": 54}
            }
        """.trimIndent()

        val req = ProtocolCodec.parse(reqJson) as WireMessage.SessionRequest
        assertEquals("sess-99", req.sessionId)
        assertEquals(TransportMode.WEBRTC, req.preferredTransport)
        assertEquals(StreamQuality.BALANCED, req.quality)

        val ready = WireMessage.SessionReady(
            sessionId = "sess-99",
            deviceId = "android-01",
            transport = TransportMode.WS_JPEG,
            screenWidth = 1080,
            screenHeight = 2400,
            rotation = 1,
        )
        val decodedReady = ProtocolCodec.parse(ProtocolCodec.serialize(ready)) as WireMessage.SessionReady
        assertEquals(TransportMode.WS_JPEG, decodedReady.transport)
        assertEquals(1, decodedReady.rotation)
    }

    @Test
    fun parseAndSerialize_allControlCommands() {
        val commands = listOf(
            ControlCommand.Tap(0.5, 0.25),
            ControlCommand.LongPress(0.4, 0.6, 750L),
            ControlCommand.Swipe(0.5, 0.8, 0.5, 0.2, 240L),
            ControlCommand.TouchDown(1, 0.1, 0.2),
            ControlCommand.TouchMove(1, 0.2, 0.3),
            ControlCommand.TouchUp(1, 0.3, 0.4),
            ControlCommand.Pinch(0.5, 0.5, 0.15, 0.55, 350L),
            ControlCommand.Key(RemoteKey.HOME),
            ControlCommand.Key(RemoteKey.SCREENSHOT),
            ControlCommand.Text("Hello 你好", submit = true),
            ControlCommand.ClipboardSet("copied text"),
            ControlCommand.Wake,
            ControlCommand.Unlock(pin = "123456"),
            ControlCommand.Quality(StreamQuality.HD),
            ControlCommand.RequestKeyframe,
        )

        for ((idx, cmd) in commands.withIndex()) {
            val wire = WireMessage.ControlCmd(
                sessionId = "sess-1",
                deviceId = "dev-1",
                seq = idx + 1,
                command = cmd,
            )
            val json = ProtocolCodec.serialize(wire)
            val parsed = ProtocolCodec.parse(json) as WireMessage.ControlCmd
            assertEquals("Failed round-trip for $cmd", cmd, parsed.command)
            assertEquals(idx + 1, parsed.seq)
        }

        val ack = WireMessage.ControlAck("sess-1", "dev-1", seq = 7, ok = true, message = "ok")
        val parsedAck = ProtocolCodec.parse(ProtocolCodec.serialize(ack)) as WireMessage.ControlAck
        assertTrue(parsedAck.ok)
        assertEquals(7, parsedAck.seq)
    }

    @Test
    fun parseAndSerialize_v02AgentRegisterAndRegisteredWithControlCodeAndAccount() {
        val reg = WireMessage.AgentRegister(
            deviceId = "android-aabbccdd",
            deviceSecret = "secret-xyz",
            accessToken = null,
            authToken = "jwt.header.payload",
            controlPassword = "482916",
            name = "Xiaomi 14",
            model = "Xiaomi 23127PN0CC",
            androidVersion = "15",
            screenWidth = 1200,
            screenHeight = 2670,
            rotation = 0,
            battery = 92,
            charging = true,
            locked = false,
            screenOn = true,
            capabilities = DeviceCapabilities(
                webrtc = true,
                wsJpeg = true,
                wsH264 = false,
                wake = true,
                unlock = true,
                accessibility = true,
                mediaProjection = true,
            ),
        )
        val regJson = ProtocolCodec.serialize(reg)
        val decodedReg = ProtocolCodec.parse(regJson) as WireMessage.AgentRegister
        assertNull(decodedReg.accessToken)
        assertEquals("jwt.header.payload", decodedReg.authToken)
        assertEquals("482916", decodedReg.controlPassword)
        assertEquals("android-aabbccdd", decodedReg.deviceId)

        val registered = WireMessage.AgentRegistered(
            deviceId = "android-aabbccdd",
            controlCode = "683291405",
            ownerUsername = "alice",
            serverTime = 1760000000000L,
            iceServers = SessionCoordinator.DEFAULT_ICE_SERVERS,
        )
        val decodedRegistered = ProtocolCodec.parse(ProtocolCodec.serialize(registered)) as WireMessage.AgentRegistered
        assertEquals("683291405", decodedRegistered.controlCode)
        assertEquals("alice", decodedRegistered.ownerUsername)
        assertEquals(2, decodedRegistered.iceServers.size)
        assertEquals("stun:stun.miwifi.com:3478", decodedRegistered.iceServers[0].urls.first())
        assertEquals("stun:stun.chat.bilibili.com:3478", decodedRegistered.iceServers[1].urls.first())
    }

    @Test
    fun parseAndSerialize_v02ControllerAuthCodeAndAccountModes() {
        val codeAuth = WireMessage.ControllerAuth(
            controlCode = "683291405",
            controlPassword = "482916",
            clientId = "ctrl-web-1",
            clientName = "Chrome",
        )
        val parsedCodeAuth = ProtocolCodec.parse(ProtocolCodec.serialize(codeAuth)) as WireMessage.ControllerAuth
        assertNull(parsedCodeAuth.accessToken)
        assertNull(parsedCodeAuth.authToken)
        assertEquals("683291405", parsedCodeAuth.controlCode)
        assertEquals("482916", parsedCodeAuth.controlPassword)

        val accountAuth = WireMessage.ControllerAuth(
            authToken = "jwt.account.token",
            clientId = "ctrl-web-2",
        )
        val parsedAccountAuth = ProtocolCodec.parse(ProtocolCodec.serialize(accountAuth)) as WireMessage.ControllerAuth
        assertEquals("jwt.account.token", parsedAccountAuth.authToken)
        assertNull(parsedAccountAuth.controlCode)

        val summary = DeviceSummary(
            deviceId = "android-02",
            controlCode = "683291405",
            ownerUsername = "alice",
            name = "Backup Phone",
            model = "Redmi K70",
            androidVersion = "14",
            online = true,
            lastSeen = 1760000000000L,
            screenWidth = 1440,
            screenHeight = 3200,
            rotation = 0,
            battery = 76,
            charging = false,
            locked = true,
            capabilities = DeviceCapabilities(
                webrtc = true,
                wsJpeg = true,
                wsH264 = false,
                wake = true,
                unlock = true,
                accessibility = true,
                mediaProjection = true,
            ),
        )
        val authed = WireMessage.ControllerAuthed(
            clientId = "ctrl-web-2",
            serverTime = 1760000005000L,
            mode = "relay",
            authType = "account",
            user = UserProfile(userId = "u-1", username = "alice", displayName = "Alice"),
            devices = listOf(summary),
            iceServers = SessionCoordinator.DEFAULT_ICE_SERVERS,
        )
        val decodedAuthed = ProtocolCodec.parse(ProtocolCodec.serialize(authed)) as WireMessage.ControllerAuthed
        assertEquals("account", decodedAuthed.authType)
        assertEquals("alice", decodedAuthed.user?.username)
        assertEquals("Alice", decodedAuthed.user?.displayName)
        assertEquals("683291405", decodedAuthed.devices.first().controlCode)
        assertEquals("alice", decodedAuthed.devices.first().ownerUsername)

        assertEquals("683291405", ProtocolCodec.normalizeControlCode("683 291-405"))
        assertEquals("683 291 405", ProtocolCodec.formatControlCode("683291405"))
    }

    @Test
    fun deriveApiBaseFromRelayUrl_handlesBuiltInCustomPortsAndFallbacks() {
        assertTrue(
            "Expected ws:// or wss:// DEFAULT_RELAY_URL, got ${BuildConfig.DEFAULT_RELAY_URL}",
            BuildConfig.DEFAULT_RELAY_URL.startsWith("ws://") || BuildConfig.DEFAULT_RELAY_URL.startsWith("wss://"),
        )
        assertTrue(
            "Expected http:// or https:// DEFAULT_API_BASE_URL, got ${BuildConfig.DEFAULT_API_BASE_URL}",
            BuildConfig.DEFAULT_API_BASE_URL.startsWith("http://") || BuildConfig.DEFAULT_API_BASE_URL.startsWith("https://"),
        )

        assertEquals(
            "http://203.0.113.10",
            AgentConfigStore.deriveApiBaseFromRelayUrl("ws://203.0.113.10/ws"),
        )
        assertEquals(
            "https://remote.example.com",
            AgentConfigStore.deriveApiBaseFromRelayUrl("wss://remote.example.com/ws"),
        )
        assertEquals(
            "https://remote.example.com:8443/sub",
            AgentConfigStore.deriveApiBaseFromRelayUrl("wss://remote.example.com:8443/sub/ws?v=2"),
        )
        assertEquals(
            "http://192.168.1.50:3000",
            AgentConfigStore.deriveApiBaseFromRelayUrl("ws://192.168.1.50:3000/ws/"),
        )
        assertEquals(
            BuildConfig.DEFAULT_API_BASE_URL.trimEnd('/'),
            AgentConfigStore.deriveApiBaseFromRelayUrl(""),
        )
        assertEquals(
            BuildConfig.DEFAULT_API_BASE_URL.trimEnd('/'),
            AgentConfigStore.deriveApiBaseFromRelayUrl("not a url"),
        )
    }

    @Test
    fun networkUtils_detectsVirtualVpnInterfacesAndAccountResponseParsing() {
        assertTrue(NetworkUtils.isVirtualVpnInterface("tun0"))
        assertTrue(NetworkUtils.isVirtualVpnInterface("pgy0"))
        assertTrue(NetworkUtils.isVirtualVpnInterface("oray_vnc0"))
        assertTrue(NetworkUtils.isVirtualVpnInterface("zt7n8x9"))
        assertTrue(NetworkUtils.isVirtualVpnInterface("easytier0"))
        assertTrue(NetworkUtils.isVirtualVpnInterface("tailscale0"))
        assertFalse(NetworkUtils.isVirtualVpnInterface("wlan0"))
        assertTrue(NetworkUtils.isTailscaleCgnatIp("100.100.1.2"))
        assertFalse(NetworkUtils.isTailscaleCgnatIp("192.168.1.2"))

        // Nested user object response
        val nested = AccountApiClient.parseAuthResponse(
            200,
            """{"ok":true,"token":"jwt-1","user":{"userId":"u1","username":"bob","displayName":"Bob"}}""",
            "bob",
        )
        assertTrue(nested.isSuccess)
        assertEquals("jwt-1", nested.getOrThrow().token)
        assertEquals("bob", nested.getOrThrow().username)
        assertEquals("Bob", nested.getOrThrow().displayName)

        // Flat response
        val flat = AccountApiClient.parseAuthResponse(
            201,
            """{"token":"jwt-2","userId":"u2","username":"carol","displayName":"Carol"}""",
            "carol",
        )
        assertTrue(flat.isSuccess)
        assertEquals("jwt-2", flat.getOrThrow().token)

        // Error mapping
        val conflict = AccountApiClient.parseAuthResponse(409, """{"error":"Username already exists"}""", "bob")
        assertTrue(conflict.isFailure)
        assertTrue(conflict.exceptionOrNull()!!.message!!.contains("已被注册"))

        val unauth = AccountApiClient.parseAuthResponse(401, """{"error":"Invalid credentials"}""", "bob")
        assertTrue(unauth.isFailure)
        assertTrue(unauth.exceptionOrNull()!!.message!!.contains("用户名或密码错误"))
    }

    @Test
    fun agentRegister_unbindOwnerSerializationAndDeserialization() {
        val baseCaps = DeviceCapabilities(
            webrtc = true,
            wsJpeg = true,
            wsH264 = false,
            wake = true,
            unlock = true,
            accessibility = true,
            mediaProjection = true,
        )

        val unbindMsg = WireMessage.AgentRegister(
            deviceId = "android-unbind-1",
            deviceSecret = "sec-1",
            accessToken = null,
            authToken = null,
            unbindOwner = true,
            controlPassword = "K9M4P7X2QA",
            name = "Test Phone",
            model = "Pixel",
            androidVersion = "15",
            screenWidth = 1080,
            screenHeight = 2400,
            rotation = 0,
            battery = 80,
            charging = false,
            locked = false,
            capabilities = baseCaps,
        )
        val unbindJson = ProtocolCodec.serialize(unbindMsg)
        assertTrue("Expected unbindOwner:true in JSON: $unbindJson", unbindJson.contains("\"unbindOwner\":true"))
        assertFalse("Public relay AgentRegister should omit null accessToken", unbindJson.contains("\"accessToken\""))
        val decodedUnbind = ProtocolCodec.parse(unbindJson) as WireMessage.AgentRegister
        assertEquals(true, decodedUnbind.unbindOwner)
        assertNull(decodedUnbind.accessToken)

        val normalMsg = unbindMsg.copy(unbindOwner = null)
        val normalJson = ProtocolCodec.serialize(normalMsg)
        assertFalse("unbindOwner should be omitted when null", normalJson.contains("unbindOwner"))
        val decodedNormal = ProtocolCodec.parse(normalJson) as WireMessage.AgentRegister
        assertNull(decodedNormal.unbindOwner)

        val falseMsg = unbindMsg.copy(unbindOwner = false)
        val falseJson = ProtocolCodec.serialize(falseMsg)
        assertFalse("unbindOwner should be omitted when false", falseJson.contains("unbindOwner"))
    }

    @Test
    fun controlPasswordGenerationAndValidation_enforcesHighEntropyUnambiguousAlphabet() {
        val alphabet = AgentConfigStore.UNAMBIGUOUS_PASSWORD_ALPHABET.toSet()
        assertFalse(alphabet.contains('0'))
        assertFalse(alphabet.contains('O'))
        assertFalse(alphabet.contains('1'))
        assertFalse(alphabet.contains('I'))
        assertEquals(32, alphabet.size)

        val generated = mutableSetOf<String>()
        repeat(50) {
            val pwd = AgentConfigStore.generateControlPassword()
            assertEquals(10, pwd.length)
            assertTrue("Generated password contains invalid char: $pwd", pwd.all { it in alphabet })
            assertTrue(AgentConfigStore.isValidControlPassword(pwd))
            generated.add(pwd)
        }
        assertTrue("Expected high uniqueness across 50 CSPRNG samples", generated.size >= 48)

        // Validation boundaries: 8..32 characters
        assertFalse(AgentConfigStore.isValidControlPassword(""))
        assertFalse(AgentConfigStore.isValidControlPassword("123456"))
        assertFalse(AgentConfigStore.isValidControlPassword("1234567"))
        assertTrue(AgentConfigStore.isValidControlPassword("ABCD2345"))
        assertTrue(AgentConfigStore.isValidControlPassword("A".repeat(32)))
        assertFalse(AgentConfigStore.isValidControlPassword("A".repeat(33)))
    }

    @Test
    fun networkUtils_fragmentQuickConnectUrlAndHtmlEscaping() {
        val endpoints = com.velodeck.agent.network.DetectedEndpoints(
            tailscaleIp = "100.64.0.10",
            lanIps = listOf("192.168.1.20"),
            port = 8765,
        )
        val quickUrl = endpoints.buildQuickConnectWebUrl("100.64.0.10", "tok+secret/123")
        assertTrue("Expected #fragment quick-connect URL, got: $quickUrl", quickUrl.startsWith("http://100.64.0.10:8765/#"))
        assertFalse("Token must never appear in HTTP query string", quickUrl.substringBefore('#').contains('?'))
        assertTrue(quickUrl.contains("url=ws%3A%2F%2F100.64.0.10%3A8765%2Fws"))
        assertTrue(quickUrl.contains("token=tok%2Bsecret%2F123"))
        assertTrue(quickUrl.endsWith("&mode=direct"))

        val escaped = NetworkUtils.escapeHtml("""<script>alert("x" & 'y')</script>""")
        assertEquals("&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;", escaped)
    }

    @Test
    fun directServer_originValidationAndRateLimiterAndDialogGuardrailAndServerInfo() {
        // Origin validation (CSWSH protection)
        assertTrue(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin(null, "192.168.1.50:8765"))
        assertTrue(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("", "192.168.1.50:8765"))
        assertTrue(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("capacitor://localhost", "192.168.1.50:8765"))
        assertTrue(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("https://localhost", "192.168.1.50:8765"))
        assertTrue(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("http://192.168.1.50:8765", "192.168.1.50:8765"))
        assertFalse(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("https://evil.example.com", "192.168.1.50:8765"))
        assertFalse(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("http://192.168.1.50:9999", "192.168.1.50:8765"))
        assertFalse(com.velodeck.agent.network.DirectServer.isAllowedDirectOrigin("null", "192.168.1.50:8765"))

        // DirectServer per-IP + global rate limiter (5 failures in 60s -> 5-minute lockout)
        var fakeNow = 1_000_000L
        val limiter = com.velodeck.agent.network.DirectAuthRateLimiter(clockMs = { fakeNow })
        repeat(4) {
            assertFalse(limiter.recordFailure("10.0.0.2"))
            assertFalse(limiter.isLockedOut("10.0.0.2"))
        }
        assertTrue(limiter.recordFailure("10.0.0.2"))
        assertTrue(limiter.isLockedOut("10.0.0.2"))
        // Global lockout also blocks rotated IPs
        assertTrue(limiter.isLockedOut("10.0.0.3"))
        // Still locked at 4m59s, unlocked after 5m
        fakeNow += 299_000L
        assertTrue(limiter.isLockedOut("10.0.0.2"))
        fakeNow += 2_000L
        assertFalse(limiter.isLockedOut("10.0.0.2"))

        // Accessibility auto-accept guardrail requires BOTH recording/casting phrase AND VeloDeck/极控 identifier
        assertTrue(
            com.velodeck.agent.input.VeloDeckAccessibilityService.isVeloDeckProjectionDialog(
                listOf("Start recording or casting with VeloDeck?", "Start now", "Cancel"),
            ),
        )
        assertTrue(
            com.velodeck.agent.input.VeloDeckAccessibilityService.isVeloDeckProjectionDialog(
                listOf("是否允许 极控 开始录制或投射屏幕？", "立即开始"),
            ),
        )
        assertTrue(
            com.velodeck.agent.input.VeloDeckAccessibilityService.isVeloDeckProjectionDialog(
                listOf("Start recording with com.velodeck.agent?", "Start now"),
            ),
        )
        assertFalse(
            com.velodeck.agent.input.VeloDeckAccessibilityService.isVeloDeckProjectionDialog(
                listOf("Start recording or casting with EvilSpyApp?", "Start now"),
            ),
        )
        assertFalse(
            com.velodeck.agent.input.VeloDeckAccessibilityService.isVeloDeckProjectionDialog(
                listOf("Allow 极控 to access contacts?", "Allow"),
            ),
        )

        // Server info inviteCode detection
        val inviteInfo = AccountApiClient.parseServerInfoResponse(
            200,
            """{"ok":true,"version":"0.2.0","hasAndroidApk":true,"requiresInviteCode":true}""",
        )
        assertTrue(inviteInfo.isSuccess)
        assertTrue(inviteInfo.getOrThrow().requiresInviteCode)

        val openInfo = AccountApiClient.parseServerInfoResponse(
            200,
            """{"ok":true,"version":"0.2.0","hasAndroidApk":false}""",
        )
        assertTrue(openInfo.isSuccess)
        assertFalse(openInfo.getOrThrow().requiresInviteCode)
    }
}
