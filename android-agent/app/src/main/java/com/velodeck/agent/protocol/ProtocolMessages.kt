package com.velodeck.agent.protocol

import org.json.JSONArray
import org.json.JSONObject

enum class TransportMode(val wireValue: String) {
    WEBRTC("webrtc"),
    WS_JPEG("ws-jpeg");

    companion object {
        fun fromWire(value: String): TransportMode =
            entries.firstOrNull { it.wireValue == value }
                ?: throw IllegalArgumentException("Unknown transport mode: $value")
    }
}

enum class RemoteKey(val wireValue: String) {
    BACK("back"),
    HOME("home"),
    RECENTS("recents"),
    NOTIFICATIONS("notifications"),
    QUICK_SETTINGS("quick_settings"),
    POWER_DIALOG("power_dialog"),
    LOCK("lock"),
    SCREENSHOT("screenshot"),
    VOLUME_UP("volume_up"),
    VOLUME_DOWN("volume_down"),
    ENTER("enter"),
    BACKSPACE("backspace");

    companion object {
        fun fromWire(value: String): RemoteKey =
            entries.firstOrNull { it.wireValue == value }
                ?: throw IllegalArgumentException("Unknown remote key: $value")
    }
}

enum class ErrorCode(val wireValue: String) {
    UNAUTHORIZED("UNAUTHORIZED"),
    DEVICE_OFFLINE("DEVICE_OFFLINE"),
    DEVICE_SECRET_MISMATCH("DEVICE_SECRET_MISMATCH"),
    INVALID_MESSAGE("INVALID_MESSAGE"),
    SESSION_NOT_FOUND("SESSION_NOT_FOUND"),
    RATE_LIMITED("RATE_LIMITED"),
    INTERNAL_ERROR("INTERNAL_ERROR");

    companion object {
        fun fromWire(value: String): ErrorCode =
            entries.firstOrNull { it.wireValue == value } ?: INTERNAL_ERROR
    }
}

data class DeviceCapabilities(
    val webrtc: Boolean,
    val wsJpeg: Boolean,
    val wsH264: Boolean,
    val wake: Boolean,
    val unlock: Boolean,
    val accessibility: Boolean,
    val mediaProjection: Boolean,
    val rootOrShizuku: Boolean? = null,
    val p2pFileTransfer: Boolean? = null,
)

data class PartialDeviceCapabilities(
    val webrtc: Boolean? = null,
    val wsJpeg: Boolean? = null,
    val wsH264: Boolean? = null,
    val wake: Boolean? = null,
    val unlock: Boolean? = null,
    val accessibility: Boolean? = null,
    val mediaProjection: Boolean? = null,
    val rootOrShizuku: Boolean? = null,
    val p2pFileTransfer: Boolean? = null,
)

data class UserProfile(
    val userId: String,
    val username: String,
    val displayName: String,
)

data class DeviceSummary(
    val deviceId: String,
    val controlCode: String? = null,
    val ownerUsername: String? = null,
    val name: String,
    val model: String,
    val androidVersion: String,
    val online: Boolean,
    val lastSeen: Long,
    val screenWidth: Int,
    val screenHeight: Int,
    val rotation: Int,
    val battery: Int,
    val charging: Boolean,
    val locked: Boolean,
    val screenOn: Boolean? = null,
    val blackScreenActive: Boolean? = null,
    val directUrl: String? = null,
    val capabilities: DeviceCapabilities,
)

data class IceServerConfig(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

data class StreamQuality(
    val maxWidth: Int,
    val fps: Int,
    val bitrateKbps: Int,
    val jpegQuality: Int,
) {
    companion object {
        val ECO = StreamQuality(maxWidth = 540, fps = 30, bitrateKbps = 1600, jpegQuality = 45)
        val BALANCED = StreamQuality(maxWidth = 900, fps = 60, bitrateKbps = 4500, jpegQuality = 54)
        val HD = StreamQuality(maxWidth = 1080, fps = 60, bitrateKbps = 7500, jpegQuality = 64)
    }
}

data class RtcIceCandidateInit(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
)

sealed interface ControlCommand {
    data class Tap(val x: Double, val y: Double) : ControlCommand
    data class LongPress(val x: Double, val y: Double, val durationMs: Long? = null) : ControlCommand
    data class Swipe(
        val x1: Double,
        val y1: Double,
        val x2: Double,
        val y2: Double,
        val durationMs: Long? = null,
    ) : ControlCommand

    data class TouchDown(val pointerId: Int, val x: Double, val y: Double) : ControlCommand
    data class TouchMove(val pointerId: Int, val x: Double, val y: Double) : ControlCommand
    data class TouchUp(val pointerId: Int, val x: Double, val y: Double) : ControlCommand
    data class Pinch(
        val cx: Double,
        val cy: Double,
        val startDist: Double,
        val endDist: Double,
        val durationMs: Long? = null,
    ) : ControlCommand

    data class Key(val key: RemoteKey) : ControlCommand
    data class Text(val text: String, val submit: Boolean? = null) : ControlCommand
    data class ClipboardSet(val text: String) : ControlCommand
    data object Wake : ControlCommand
    data class Unlock(val pin: String? = null) : ControlCommand
    data class BlackScreen(val enabled: Boolean) : ControlCommand
    data class Quality(val quality: StreamQuality) : ControlCommand
    data object RequestKeyframe : ControlCommand
}

sealed interface WireMessage {
    val type: String

    data class AgentRegister(
        val deviceId: String,
        val deviceSecret: String,
        val accessToken: String? = null,
        val authToken: String? = null,
        val unbindOwner: Boolean? = null,
        val controlPassword: String? = null,
        val name: String,
        val model: String,
        val androidVersion: String,
        val screenWidth: Int,
        val screenHeight: Int,
        val rotation: Int,
        val battery: Int,
        val charging: Boolean,
        val locked: Boolean,
        val screenOn: Boolean? = null,
        val blackScreenActive: Boolean? = null,
        val directUrl: String? = null,
        val capabilities: DeviceCapabilities,
    ) : WireMessage {
        override val type: String = "agent.register"
    }

    data class AgentRegistered(
        val deviceId: String,
        val controlCode: String? = null,
        val ownerUsername: String? = null,
        val serverTime: Long,
        val iceServers: List<IceServerConfig>,
    ) : WireMessage {
        override val type: String = "agent.registered"
    }

    data class AgentTelemetry(
        val deviceId: String,
        val screenWidth: Int? = null,
        val screenHeight: Int? = null,
        val rotation: Int? = null,
        val battery: Int? = null,
        val charging: Boolean? = null,
        val locked: Boolean? = null,
        val screenOn: Boolean? = null,
        val blackScreenActive: Boolean? = null,
        val capabilities: PartialDeviceCapabilities? = null,
    ) : WireMessage {
        override val type: String = "agent.telemetry"
    }

    data class ControllerAuth(
        val accessToken: String? = null,
        val authToken: String? = null,
        val controlCode: String? = null,
        val controlPassword: String? = null,
        val clientId: String,
        val clientName: String? = null,
    ) : WireMessage {
        override val type: String = "controller.auth"
    }

    data class ControllerAuthed(
        val clientId: String,
        val serverTime: Long,
        val mode: String, // "relay" | "direct"
        val authType: String? = null, // "account" | "code" | "token"
        val user: UserProfile? = null,
        val devices: List<DeviceSummary>,
        val iceServers: List<IceServerConfig>,
    ) : WireMessage {
        override val type: String = "controller.authed"
    }

    data class DeviceStatus(
        val device: DeviceSummary,
    ) : WireMessage {
        override val type: String = "device.status"
    }

    data class SessionRequest(
        val sessionId: String,
        val deviceId: String,
        val preferredTransport: TransportMode,
        val quality: StreamQuality,
        val iceServers: List<IceServerConfig>? = null,
    ) : WireMessage {
        override val type: String = "session.request"
    }

    data class SessionReady(
        val sessionId: String,
        val deviceId: String,
        val transport: TransportMode,
        val screenWidth: Int,
        val screenHeight: Int,
        val rotation: Int,
        val iceServers: List<IceServerConfig>? = null,
    ) : WireMessage {
        override val type: String = "session.ready"
    }

    data class SessionEnd(
        val sessionId: String,
        val deviceId: String,
        val reason: String? = null,
    ) : WireMessage {
        override val type: String = "session.end"
    }

    data class RtcOffer(
        val sessionId: String,
        val deviceId: String,
        val sdp: String,
    ) : WireMessage {
        override val type: String = "rtc.offer"
    }

    data class RtcAnswer(
        val sessionId: String,
        val deviceId: String,
        val sdp: String,
    ) : WireMessage {
        override val type: String = "rtc.answer"
    }

    data class RtcIce(
        val sessionId: String,
        val deviceId: String,
        val candidate: RtcIceCandidateInit,
    ) : WireMessage {
        override val type: String = "rtc.ice"
    }

    data class ControlCmd(
        val sessionId: String,
        val deviceId: String,
        val seq: Int? = null,
        val command: ControlCommand,
    ) : WireMessage {
        override val type: String = "control.cmd"
    }

    data class ControlAck(
        val sessionId: String,
        val deviceId: String,
        val seq: Int? = null,
        val ok: Boolean,
        val message: String? = null,
    ) : WireMessage {
        override val type: String = "control.ack"
    }

    data class ClipboardSync(
        val sessionId: String,
        val deviceId: String,
        val text: String,
    ) : WireMessage {
        override val type: String = "clipboard.sync"
    }

    data class Ping(val ts: Long) : WireMessage {
        override val type: String = "ping"
    }

    data class Pong(val ts: Long) : WireMessage {
        override val type: String = "pong"
    }

    data class Error(
        val code: ErrorCode,
        val message: String,
        val sessionId: String? = null,
        val deviceId: String? = null,
    ) : WireMessage {
        override val type: String = "error"
    }
}

object ProtocolCodec {

    fun serialize(message: WireMessage): String = toJson(message).toString()

    fun parse(raw: String): WireMessage {
        val json = JSONObject(raw)
        return fromJson(json)
    }

    fun toJson(message: WireMessage): JSONObject = when (message) {
        is WireMessage.AgentRegister -> JSONObject().apply {
            put("type", message.type)
            put("deviceId", message.deviceId)
            put("deviceSecret", message.deviceSecret)
            message.accessToken?.let { put("accessToken", it) }
            message.authToken?.let { put("authToken", it) }
            if (message.unbindOwner == true) put("unbindOwner", true)
            message.controlPassword?.let { put("controlPassword", it) }
            put("name", message.name)
            put("model", message.model)
            put("androidVersion", message.androidVersion)
            put("screenWidth", message.screenWidth)
            put("screenHeight", message.screenHeight)
            put("rotation", message.rotation and 0x03)
            put("battery", message.battery)
            put("charging", message.charging)
            put("locked", message.locked)
            message.screenOn?.let { put("screenOn", it) }
            message.blackScreenActive?.let { put("blackScreenActive", it) }
            message.directUrl?.let { put("directUrl", it) }
            put("capabilities", capabilitiesToJson(message.capabilities))
        }

        is WireMessage.AgentRegistered -> JSONObject().apply {
            put("type", message.type)
            put("deviceId", message.deviceId)
            message.controlCode?.let { put("controlCode", it) }
            message.ownerUsername?.let { put("ownerUsername", it) }
            put("serverTime", message.serverTime)
            put("iceServers", iceServersToJson(message.iceServers))
        }

        is WireMessage.AgentTelemetry -> JSONObject().apply {
            put("type", message.type)
            put("deviceId", message.deviceId)
            message.screenWidth?.let { put("screenWidth", it) }
            message.screenHeight?.let { put("screenHeight", it) }
            message.rotation?.let { put("rotation", it and 0x03) }
            message.battery?.let { put("battery", it) }
            message.charging?.let { put("charging", it) }
            message.locked?.let { put("locked", it) }
            message.screenOn?.let { put("screenOn", it) }
            message.blackScreenActive?.let { put("blackScreenActive", it) }
            message.capabilities?.let { put("capabilities", partialCapabilitiesToJson(it)) }
        }

        is WireMessage.ControllerAuth -> JSONObject().apply {
            put("type", message.type)
            message.accessToken?.let { put("accessToken", it) }
            message.authToken?.let { put("authToken", it) }
            message.controlCode?.let { put("controlCode", it) }
            message.controlPassword?.let { put("controlPassword", it) }
            put("clientId", message.clientId)
            message.clientName?.let { put("clientName", it) }
        }

        is WireMessage.ControllerAuthed -> JSONObject().apply {
            put("type", message.type)
            put("clientId", message.clientId)
            put("serverTime", message.serverTime)
            put("mode", message.mode)
            message.authType?.let { put("authType", it) }
            message.user?.let { put("user", userProfileToJson(it)) }
            put("devices", JSONArray().apply {
                message.devices.forEach { put(deviceSummaryToJson(it)) }
            })
            put("iceServers", iceServersToJson(message.iceServers))
        }

        is WireMessage.DeviceStatus -> JSONObject().apply {
            put("type", message.type)
            put("device", deviceSummaryToJson(message.device))
        }

        is WireMessage.SessionRequest -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("preferredTransport", message.preferredTransport.wireValue)
            put("quality", streamQualityToJson(message.quality))
            message.iceServers?.let { put("iceServers", iceServersToJson(it)) }
        }

        is WireMessage.SessionReady -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("transport", message.transport.wireValue)
            put("screenWidth", message.screenWidth)
            put("screenHeight", message.screenHeight)
            put("rotation", message.rotation and 0x03)
            message.iceServers?.let { put("iceServers", iceServersToJson(it)) }
        }

        is WireMessage.SessionEnd -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            message.reason?.let { put("reason", it) }
        }

        is WireMessage.RtcOffer -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("sdp", message.sdp)
        }

        is WireMessage.RtcAnswer -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("sdp", message.sdp)
        }

        is WireMessage.RtcIce -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("candidate", JSONObject().apply {
                put("candidate", message.candidate.candidate)
                if (message.candidate.sdpMid != null) put("sdpMid", message.candidate.sdpMid)
                if (message.candidate.sdpMLineIndex != null) {
                    put("sdpMLineIndex", message.candidate.sdpMLineIndex)
                }
            })
        }

        is WireMessage.ControlCmd -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            message.seq?.let { put("seq", it) }
            put("command", controlCommandToJson(message.command))
        }

        is WireMessage.ControlAck -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            message.seq?.let { put("seq", it) }
            put("ok", message.ok)
            message.message?.let { put("message", it) }
        }

        is WireMessage.ClipboardSync -> JSONObject().apply {
            put("type", message.type)
            put("sessionId", message.sessionId)
            put("deviceId", message.deviceId)
            put("text", message.text)
        }

        is WireMessage.Ping -> JSONObject().apply {
            put("type", message.type)
            put("ts", message.ts)
        }

        is WireMessage.Pong -> JSONObject().apply {
            put("type", message.type)
            put("ts", message.ts)
        }

        is WireMessage.Error -> JSONObject().apply {
            put("type", message.type)
            put("code", message.code.wireValue)
            put("message", message.message)
            message.sessionId?.let { put("sessionId", it) }
            message.deviceId?.let { put("deviceId", it) }
        }
    }

    fun fromJson(json: JSONObject): WireMessage {
        return when (val type = json.getString("type")) {
            "agent.register" -> WireMessage.AgentRegister(
                deviceId = json.getString("deviceId"),
                deviceSecret = json.getString("deviceSecret"),
                accessToken = json.optNullableString("accessToken"),
                authToken = json.optNullableString("authToken"),
                unbindOwner = json.optNullableBoolean("unbindOwner"),
                controlPassword = json.optNullableString("controlPassword"),
                name = json.getString("name"),
                model = json.getString("model"),
                androidVersion = json.getString("androidVersion"),
                screenWidth = json.getInt("screenWidth"),
                screenHeight = json.getInt("screenHeight"),
                rotation = json.getInt("rotation") and 0x03,
                battery = json.getInt("battery"),
                charging = json.getBoolean("charging"),
                locked = json.getBoolean("locked"),
                screenOn = json.optNullableBoolean("screenOn"),
                blackScreenActive = json.optNullableBoolean("blackScreenActive"),
                directUrl = json.optNullableString("directUrl"),
                capabilities = capabilitiesFromJson(json.getJSONObject("capabilities")),
            )

            "agent.registered" -> WireMessage.AgentRegistered(
                deviceId = json.getString("deviceId"),
                controlCode = json.optNullableString("controlCode"),
                ownerUsername = json.optNullableString("ownerUsername"),
                serverTime = json.getLong("serverTime"),
                iceServers = iceServersFromJson(json.optJSONArray("iceServers")),
            )

            "agent.telemetry" -> WireMessage.AgentTelemetry(
                deviceId = json.getString("deviceId"),
                screenWidth = json.optNullableInt("screenWidth"),
                screenHeight = json.optNullableInt("screenHeight"),
                rotation = json.optNullableInt("rotation")?.and(0x03),
                battery = json.optNullableInt("battery"),
                charging = json.optNullableBoolean("charging"),
                locked = json.optNullableBoolean("locked"),
                screenOn = json.optNullableBoolean("screenOn"),
                blackScreenActive = json.optNullableBoolean("blackScreenActive"),
                capabilities = json.optJSONObject("capabilities")?.let { partialCapabilitiesFromJson(it) },
            )

            "controller.auth" -> WireMessage.ControllerAuth(
                accessToken = json.optNullableString("accessToken"),
                authToken = json.optNullableString("authToken"),
                controlCode = json.optNullableString("controlCode"),
                controlPassword = json.optNullableString("controlPassword"),
                clientId = json.getString("clientId"),
                clientName = json.optNullableString("clientName"),
            )

            "controller.authed" -> WireMessage.ControllerAuthed(
                clientId = json.getString("clientId"),
                serverTime = json.getLong("serverTime"),
                mode = json.getString("mode"),
                authType = json.optNullableString("authType"),
                user = json.optJSONObject("user")?.let { userProfileFromJson(it) },
                devices = buildList {
                    val arr = json.optJSONArray("devices")
                    if (arr != null) {
                        for (i in 0 until arr.length()) {
                            add(deviceSummaryFromJson(arr.getJSONObject(i)))
                        }
                    }
                },
                iceServers = iceServersFromJson(json.optJSONArray("iceServers")),
            )

            "device.status" -> WireMessage.DeviceStatus(
                device = deviceSummaryFromJson(json.getJSONObject("device")),
            )

            "session.request" -> WireMessage.SessionRequest(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                preferredTransport = TransportMode.fromWire(json.getString("preferredTransport")),
                quality = streamQualityFromJson(json.getJSONObject("quality")),
                iceServers = json.optJSONArray("iceServers")?.let { iceServersFromJson(it) },
            )

            "session.ready" -> WireMessage.SessionReady(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                transport = TransportMode.fromWire(json.getString("transport")),
                screenWidth = json.getInt("screenWidth"),
                screenHeight = json.getInt("screenHeight"),
                rotation = json.getInt("rotation") and 0x03,
                iceServers = json.optJSONArray("iceServers")?.let { iceServersFromJson(it) },
            )

            "session.end" -> WireMessage.SessionEnd(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                reason = json.optNullableString("reason"),
            )

            "rtc.offer" -> WireMessage.RtcOffer(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                sdp = json.getString("sdp"),
            )

            "rtc.answer" -> WireMessage.RtcAnswer(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                sdp = json.getString("sdp"),
            )

            "rtc.ice" -> {
                val cand = json.getJSONObject("candidate")
                WireMessage.RtcIce(
                    sessionId = json.getString("sessionId"),
                    deviceId = json.getString("deviceId"),
                    candidate = RtcIceCandidateInit(
                        candidate = cand.getString("candidate"),
                        sdpMid = cand.optNullableString("sdpMid"),
                        sdpMLineIndex = cand.optNullableInt("sdpMLineIndex"),
                    ),
                )
            }

            "control.cmd" -> WireMessage.ControlCmd(
                sessionId = json.optNullableString("sessionId") ?: "",
                deviceId = json.getString("deviceId"),
                seq = json.optNullableInt("seq"),
                command = controlCommandFromJson(json.getJSONObject("command")),
            )

            "control.ack" -> WireMessage.ControlAck(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                seq = json.optNullableInt("seq"),
                ok = json.getBoolean("ok"),
                message = json.optNullableString("message"),
            )

            "clipboard.sync" -> WireMessage.ClipboardSync(
                sessionId = json.getString("sessionId"),
                deviceId = json.getString("deviceId"),
                text = json.getString("text"),
            )

            "ping" -> WireMessage.Ping(ts = json.getLong("ts"))
            "pong" -> WireMessage.Pong(ts = json.getLong("ts"))

            "error" -> WireMessage.Error(
                code = ErrorCode.fromWire(json.getString("code")),
                message = json.getString("message"),
                sessionId = json.optNullableString("sessionId"),
                deviceId = json.optNullableString("deviceId"),
            )

            else -> throw IllegalArgumentException("Unknown wire message type: $type")
        }
    }

    fun controlCommandToJson(cmd: ControlCommand): JSONObject = when (cmd) {
        is ControlCommand.Tap -> JSONObject().apply {
            put("action", "tap")
            put("x", cmd.x)
            put("y", cmd.y)
        }

        is ControlCommand.LongPress -> JSONObject().apply {
            put("action", "long_press")
            put("x", cmd.x)
            put("y", cmd.y)
            cmd.durationMs?.let { put("durationMs", it) }
        }

        is ControlCommand.Swipe -> JSONObject().apply {
            put("action", "swipe")
            put("x1", cmd.x1)
            put("y1", cmd.y1)
            put("x2", cmd.x2)
            put("y2", cmd.y2)
            cmd.durationMs?.let { put("durationMs", it) }
        }

        is ControlCommand.TouchDown -> JSONObject().apply {
            put("action", "touch_down")
            put("pointerId", cmd.pointerId)
            put("x", cmd.x)
            put("y", cmd.y)
        }

        is ControlCommand.TouchMove -> JSONObject().apply {
            put("action", "touch_move")
            put("pointerId", cmd.pointerId)
            put("x", cmd.x)
            put("y", cmd.y)
        }

        is ControlCommand.TouchUp -> JSONObject().apply {
            put("action", "touch_up")
            put("pointerId", cmd.pointerId)
            put("x", cmd.x)
            put("y", cmd.y)
        }

        is ControlCommand.Pinch -> JSONObject().apply {
            put("action", "pinch")
            put("cx", cmd.cx)
            put("cy", cmd.cy)
            put("startDist", cmd.startDist)
            put("endDist", cmd.endDist)
            cmd.durationMs?.let { put("durationMs", it) }
        }

        is ControlCommand.Key -> JSONObject().apply {
            put("action", "key")
            put("key", cmd.key.wireValue)
        }

        is ControlCommand.Text -> JSONObject().apply {
            put("action", "text")
            put("text", cmd.text)
            cmd.submit?.let { put("submit", it) }
        }

        is ControlCommand.ClipboardSet -> JSONObject().apply {
            put("action", "clipboard_set")
            put("text", cmd.text)
        }

        is ControlCommand.Wake -> JSONObject().apply {
            put("action", "wake")
        }

        is ControlCommand.Unlock -> JSONObject().apply {
            put("action", "unlock")
            cmd.pin?.let { put("pin", it) }
        }

        is ControlCommand.BlackScreen -> JSONObject().apply {
            put("action", "black_screen")
            put("enabled", cmd.enabled)
        }

        is ControlCommand.Quality -> JSONObject().apply {
            put("action", "quality")
            put("quality", streamQualityToJson(cmd.quality))
        }

        is ControlCommand.RequestKeyframe -> JSONObject().apply {
            put("action", "request_keyframe")
        }
    }

    fun controlCommandFromJson(json: JSONObject): ControlCommand =
        when (val action = json.getString("action")) {
            "tap" -> ControlCommand.Tap(
                x = json.getDouble("x"),
                y = json.getDouble("y"),
            )

            "long_press" -> ControlCommand.LongPress(
                x = json.getDouble("x"),
                y = json.getDouble("y"),
                durationMs = json.optNullableLong("durationMs"),
            )

            "swipe" -> ControlCommand.Swipe(
                x1 = json.getDouble("x1"),
                y1 = json.getDouble("y1"),
                x2 = json.getDouble("x2"),
                y2 = json.getDouble("y2"),
                durationMs = json.optNullableLong("durationMs"),
            )

            "touch_down" -> ControlCommand.TouchDown(
                pointerId = json.getInt("pointerId"),
                x = json.getDouble("x"),
                y = json.getDouble("y"),
            )

            "touch_move" -> ControlCommand.TouchMove(
                pointerId = json.getInt("pointerId"),
                x = json.getDouble("x"),
                y = json.getDouble("y"),
            )

            "touch_up" -> ControlCommand.TouchUp(
                pointerId = json.getInt("pointerId"),
                x = json.getDouble("x"),
                y = json.getDouble("y"),
            )

            "pinch" -> ControlCommand.Pinch(
                cx = json.getDouble("cx"),
                cy = json.getDouble("cy"),
                startDist = json.getDouble("startDist"),
                endDist = json.getDouble("endDist"),
                durationMs = json.optNullableLong("durationMs"),
            )

            "key" -> ControlCommand.Key(
                key = RemoteKey.fromWire(json.getString("key")),
            )

            "text" -> ControlCommand.Text(
                text = json.getString("text"),
                submit = json.optNullableBoolean("submit"),
            )

            "clipboard_set" -> ControlCommand.ClipboardSet(
                text = json.getString("text"),
            )

            "wake" -> ControlCommand.Wake

            "unlock" -> ControlCommand.Unlock(
                pin = json.optNullableString("pin"),
            )

            "black_screen" -> ControlCommand.BlackScreen(
                enabled = json.optBoolean("enabled", true),
            )

            "quality" -> ControlCommand.Quality(
                quality = streamQualityFromJson(json.getJSONObject("quality")),
            )

            "request_keyframe" -> ControlCommand.RequestKeyframe

            else -> throw IllegalArgumentException("Unknown control command action: $action")
        }

    fun capabilitiesToJson(cap: DeviceCapabilities): JSONObject = JSONObject().apply {
        put("webrtc", cap.webrtc)
        put("wsJpeg", cap.wsJpeg)
        put("wsH264", cap.wsH264)
        put("wake", cap.wake)
        put("unlock", cap.unlock)
        put("accessibility", cap.accessibility)
        put("mediaProjection", cap.mediaProjection)
        cap.rootOrShizuku?.let { put("rootOrShizuku", it) }
        cap.p2pFileTransfer?.let { put("p2pFileTransfer", it) }
    }

    fun capabilitiesFromJson(json: JSONObject): DeviceCapabilities = DeviceCapabilities(
        webrtc = json.optBoolean("webrtc", false),
        wsJpeg = json.optBoolean("wsJpeg", true),
        wsH264 = json.optBoolean("wsH264", false),
        wake = json.optBoolean("wake", false),
        unlock = json.optBoolean("unlock", false),
        accessibility = json.optBoolean("accessibility", false),
        mediaProjection = json.optBoolean("mediaProjection", false),
        rootOrShizuku = json.optNullableBoolean("rootOrShizuku"),
        p2pFileTransfer = json.optNullableBoolean("p2pFileTransfer"),
    )

    fun partialCapabilitiesToJson(cap: PartialDeviceCapabilities): JSONObject = JSONObject().apply {
        cap.webrtc?.let { put("webrtc", it) }
        cap.wsJpeg?.let { put("wsJpeg", it) }
        cap.wsH264?.let { put("wsH264", it) }
        cap.wake?.let { put("wake", it) }
        cap.unlock?.let { put("unlock", it) }
        cap.accessibility?.let { put("accessibility", it) }
        cap.mediaProjection?.let { put("mediaProjection", it) }
        cap.rootOrShizuku?.let { put("rootOrShizuku", it) }
        cap.p2pFileTransfer?.let { put("p2pFileTransfer", it) }
    }

    fun partialCapabilitiesFromJson(json: JSONObject): PartialDeviceCapabilities =
        PartialDeviceCapabilities(
            webrtc = json.optNullableBoolean("webrtc"),
            wsJpeg = json.optNullableBoolean("wsJpeg"),
            wsH264 = json.optNullableBoolean("wsH264"),
            wake = json.optNullableBoolean("wake"),
            unlock = json.optNullableBoolean("unlock"),
            accessibility = json.optNullableBoolean("accessibility"),
            mediaProjection = json.optNullableBoolean("mediaProjection"),
            rootOrShizuku = json.optNullableBoolean("rootOrShizuku"),
            p2pFileTransfer = json.optNullableBoolean("p2pFileTransfer"),
        )

    fun userProfileToJson(user: UserProfile): JSONObject = JSONObject().apply {
        put("userId", user.userId)
        put("username", user.username)
        put("displayName", user.displayName)
    }

    fun userProfileFromJson(json: JSONObject): UserProfile = UserProfile(
        userId = json.getString("userId"),
        username = json.getString("username"),
        displayName = json.optString("displayName", json.getString("username")),
    )

    fun deviceSummaryToJson(device: DeviceSummary): JSONObject = JSONObject().apply {
        put("deviceId", device.deviceId)
        device.controlCode?.let { put("controlCode", it) }
        device.ownerUsername?.let { put("ownerUsername", it) }
        put("name", device.name)
        put("model", device.model)
        put("androidVersion", device.androidVersion)
        put("online", device.online)
        put("lastSeen", device.lastSeen)
        put("screenWidth", device.screenWidth)
        put("screenHeight", device.screenHeight)
        put("rotation", device.rotation and 0x03)
        put("battery", device.battery)
        put("charging", device.charging)
        put("locked", device.locked)
        device.screenOn?.let { put("screenOn", it) }
        device.blackScreenActive?.let { put("blackScreenActive", it) }
        device.directUrl?.let { put("directUrl", it) }
        put("capabilities", capabilitiesToJson(device.capabilities))
    }

    fun deviceSummaryFromJson(json: JSONObject): DeviceSummary = DeviceSummary(
        deviceId = json.getString("deviceId"),
        controlCode = json.optNullableString("controlCode"),
        ownerUsername = json.optNullableString("ownerUsername"),
        name = json.getString("name"),
        model = json.getString("model"),
        androidVersion = json.getString("androidVersion"),
        online = json.getBoolean("online"),
        lastSeen = json.getLong("lastSeen"),
        screenWidth = json.getInt("screenWidth"),
        screenHeight = json.getInt("screenHeight"),
        rotation = json.getInt("rotation") and 0x03,
        battery = json.getInt("battery"),
        charging = json.getBoolean("charging"),
        locked = json.getBoolean("locked"),
        screenOn = json.optNullableBoolean("screenOn"),
        blackScreenActive = json.optNullableBoolean("blackScreenActive"),
        directUrl = json.optNullableString("directUrl"),
        capabilities = capabilitiesFromJson(json.getJSONObject("capabilities")),
    )

    fun streamQualityToJson(quality: StreamQuality): JSONObject = JSONObject().apply {
        put("maxWidth", quality.maxWidth)
        put("fps", quality.fps)
        put("bitrateKbps", quality.bitrateKbps)
        put("jpegQuality", quality.jpegQuality)
    }

    fun streamQualityFromJson(json: JSONObject): StreamQuality = StreamQuality(
        maxWidth = json.optInt("maxWidth", StreamQuality.BALANCED.maxWidth),
        fps = json.optInt("fps", StreamQuality.BALANCED.fps),
        bitrateKbps = json.optInt("bitrateKbps", StreamQuality.BALANCED.bitrateKbps),
        jpegQuality = json.optInt("jpegQuality", StreamQuality.BALANCED.jpegQuality),
    )

    fun iceServersToJson(servers: List<IceServerConfig>): JSONArray = JSONArray().apply {
        servers.forEach { srv ->
            put(JSONObject().apply {
                if (srv.urls.size == 1) {
                    put("urls", srv.urls.first())
                } else {
                    put("urls", JSONArray(srv.urls))
                }
                srv.username?.let { put("username", it) }
                srv.credential?.let { put("credential", it) }
            })
        }
    }

    fun iceServersFromJson(array: JSONArray?): List<IceServerConfig> {
        if (array == null) return emptyList()
        return buildList {
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                val urlsRaw = obj.opt("urls")
                val urls = when (urlsRaw) {
                    is String -> listOf(urlsRaw)
                    is JSONArray -> buildList {
                        for (j in 0 until urlsRaw.length()) {
                            add(urlsRaw.getString(j))
                        }
                    }
                    else -> emptyList()
                }
                if (urls.isNotEmpty()) {
                    add(
                        IceServerConfig(
                            urls = urls,
                            username = obj.optNullableString("username"),
                            credential = obj.optNullableString("credential"),
                        ),
                    )
                }
            }
        }
    }

    private fun JSONObject.optNullableString(key: String): String? =
        if (has(key) && !isNull(key)) getString(key) else null

    private fun JSONObject.optNullableInt(key: String): Int? =
        if (has(key) && !isNull(key)) getInt(key) else null

    private fun JSONObject.optNullableLong(key: String): Long? =
        if (has(key) && !isNull(key)) getLong(key) else null

    private fun JSONObject.optNullableBoolean(key: String): Boolean? =
        if (has(key) && !isNull(key)) getBoolean(key) else null

    /** Strips spaces/dashes from a 9-digit control code. */
    fun normalizeControlCode(raw: String): String =
        raw.replace(Regex("[\\s-]+"), "").trim()

    /** Formats a 9-digit control code as "683 291 405". */
    fun formatControlCode(raw: String): String {
        val clean = normalizeControlCode(raw)
        if (clean.length != 9) return clean
        return "${clean.substring(0, 3)} ${clean.substring(3, 6)} ${clean.substring(6, 9)}"
    }
}
