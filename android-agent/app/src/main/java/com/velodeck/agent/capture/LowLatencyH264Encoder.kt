package com.velodeck.agent.capture

import android.annotation.SuppressLint
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.opengl.GLES20
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import com.velodeck.agent.protocol.StreamQuality
import org.webrtc.EglBase
import org.webrtc.EglBase14
import org.webrtc.EncodedImage
import org.webrtc.GlRectDrawer
import org.webrtc.VideoCodecStatus
import org.webrtc.VideoEncoder
import org.webrtc.VideoFrame
import org.webrtc.VideoFrameDrawer
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.round

/**
 * Pure algorithmic helpers for [LowLatencyH264Encoder] — kept Android-free so JVM unit tests can
 * exhaustively verify PTS clamping, Annex-B SPS detection, bitrate clamping, and PLI throttling.
 */
internal object LowLatencyEncoderMath {
    const val MIN_FRAME_DELTA_NS = 8_000_000L            // 8ms (125fps burst ceiling & consecutive idle step)
    const val MAX_FRAME_DELTA_NS = 1_000_000_000L / 60   // 16.67ms (60fps default motion ceiling -> prevents CBR bursts)
    const val STATIC_SETTLE_RAW_DELTA_NS = 180_000_000L  // >= 180ms real pause -> user stopped scrolling to read
    const val STATIC_SETTLE_DELTA_NS = 20_000_000L       // 20ms one-shot refinement budget right after motion stops
    const val DEFAULT_FRAME_DELTA_NS = 1_000_000_000L / 60 // 60fps nominal step
    const val IDLE_RESUME_RAW_DELTA_NS = 300_000_000L    // >= 300ms gap after idle triggers VBV leaky-bucket re-arm
    const val VBV_REARM_BITRATE_NUMERATOR = 75           // Briefly clamp bitrate to 75% on idle->motion resume
    const val VBV_REARM_BITRATE_DENOMINATOR = 100
    const val VBV_REARM_RESTORE_MS = 250L                // Restore 100% target bitrate after 250ms or 10 frames
    const val VBV_REARM_RESTORE_FRAMES = 10
    const val MAX_IN_FLIGHT_FRAMES = 3                   // <= 50ms worst-case encoder input queue depth at 60fps
    const val MIN_CAPTURE_MONOTONIC_STEP_NS = 1_000_000L // 1ms minimum monotonic advance for synthetic/jitter frames
    const val MIN_BITRATE_BPS = 300_000
    const val MAX_BITRATE_BPS = 12_000_000
    const val MIN_KEYFRAME_INTERVAL_MS = 350L
    const val BITRATE_UPDATE_MIN_INTERVAL_MS = 150L
    const val BITRATE_CHANGE_THRESHOLD_RATIO = 0.03
    const val SPS_SCAN_LIMIT_BYTES = 512
    const val OPERATING_RATE_FPS = 120
    const val AVC_LEVEL_42_MAX_FS_MB = 8_704L
    const val AVC_LEVEL_42_MAX_MBPS = 522_240L
    const val AVC_LEVEL_51_MAX_MBPS = 983_040L
    const val QP_MIN = 20
    const val QP_I_MAX = 42
    const val QP_P_MAX = 46
    const val STATIC_PUMP_STARTUP_WINDOW_MS = 3_000L
    const val STATIC_PUMP_POST_MOTION_SETTLE_MS = 1_000L
    const val STATIC_PUMP_FAST_INTERVAL_MS = 250L
    const val STATIC_PUMP_IDLE_INTERVAL_MS = 1_500L

    /**
     * Normalizes a `SurfaceTexture` capture timestamp into a strictly monotonic `CLOCK_MONOTONIC`
     * (`System.nanoTime()`) timeline suitable for `libwebrtc`'s `VideoAdapter` and `TimestampAligner`.
     *
     * `SurfaceTexture.getTimestamp()` uses `CLOCK_MONOTONIC`, so [nowNs] MUST also come from
     * `System.nanoTime()` (never `SystemClock.elapsedRealtimeNanos()` / `CLOCK_BOOTTIME`, which
     * advances across deep sleep and would poison subsequent real VirtualDisplay frames).
     *
     * - Real VirtualDisplay frames (`rawTsNs > 0L && rawTsNs != lastRawSurfaceTsNs`):
     *   delivered unchanged when `rawTsNs > lastDeliveredTsNs` so native 90/120Hz cadence is
     *   preserved for clean 120->60fps decimation; otherwise clamped monotonically by >= 1ms
     *   (never +16.67ms).
     * - Synthetic `forceFrame()` / pre-first-draw frames (`rawTsNs == 0L || rawTsNs == lastRawSurfaceTsNs`):
     *   monotonically advanced and anchored to real `nowNs` with zero runaway.
     */
    fun normalizeCaptureTimestampNs(
        rawTsNs: Long,
        nowNs: Long,
        lastRawSurfaceTsNs: Long,
        lastDeliveredTsNs: Long,
    ): Long {
        val isRealFrame = rawTsNs > 0L && rawTsNs != lastRawSurfaceTsNs
        if (isRealFrame && rawTsNs > lastDeliveredTsNs) {
            return rawTsNs
        }
        return if (lastDeliveredTsNs > 0L) {
            maxOf(lastDeliveredTsNs + MIN_CAPTURE_MONOTONIC_STEP_NS, nowNs)
        } else {
            nowNs
        }
    }

    /**
     * Scales the maximum motion codec PTS step to match the active encoder frame rate (`20..60 fps`)
     * so 30fps ECO / 20fps Auto streams receive proper nominal frame budgets without PTS starvation.
     */
    fun maxFrameDeltaNsForFps(targetFps: Int): Long =
        1_000_000_000L / targetFps.coerceIn(20, 60)

    /**
     * Computes the next clamped monotonic codec PTS (in nanoseconds) given the previous real frame
     * timestamp, the current real frame timestamp, and the previous codec PTS.
     *
     * - During active motion (`rawDeltaNs < 180ms`), `dt` is clamped to
     *   `[8ms, 1_000_000_000L / targetFps.coerceIn(24, 60)]` so Qualcomm CBR matches [targetFps]
     *   without idle-gap bursts or 30fps ECO starvation.
     * - When motion stops (`rawDeltaNs >= 180ms`), allows at most ONE `20ms` settle step
     *   ([consecutiveIdleGaps] == 0) to sharpen static text; all subsequent consecutive idle frames
     *   use `MIN_FRAME_DELTA_NS` (`8ms`) so repeated static frames never accumulate surplus VBV credit.
     */
    fun nextClampedCodecPtsNs(
        previousRealTsNs: Long,
        currentRealTsNs: Long,
        previousCodecPtsNs: Long,
        targetFps: Int = 60,
        consecutiveIdleGaps: Int = 0,
    ): Long {
        val maxDeltaNs = maxFrameDeltaNsForFps(targetFps)
        if (previousRealTsNs == Long.MIN_VALUE) {
            return maxDeltaNs
        }
        val rawDeltaNs = currentRealTsNs - previousRealTsNs
        val clampedDeltaNs = when {
            rawDeltaNs <= 0L -> MIN_FRAME_DELTA_NS
            rawDeltaNs >= STATIC_SETTLE_RAW_DELTA_NS -> {
                if (consecutiveIdleGaps == 0) STATIC_SETTLE_DELTA_NS else MIN_FRAME_DELTA_NS
            }
            else -> rawDeltaNs.coerceIn(MIN_FRAME_DELTA_NS, maxDeltaNs)
        }
        return previousCodecPtsNs + clampedDeltaNs
    }

    /**
     * Computes the brief 75% VBV re-arm bitrate sent on idle->motion resume so `c2.qti.avc.encoder`
     * re-clamps its leaky-bucket fullness instead of emitting a 150 KB surplus burst.
     */
    fun computeVbvRearmBitrateBps(
        currentBitrateBps: Int,
        lastAppliedCodecBitrateBps: Int = -1,
    ): Int {
        val base = ((currentBitrateBps.toLong() * VBV_REARM_BITRATE_NUMERATOR) / VBV_REARM_BITRATE_DENOMINATOR)
            .toInt()
            .coerceIn(MIN_BITRATE_BPS, MAX_BITRATE_BPS)
        return if (base == lastAppliedCodecBitrateBps && base > MIN_BITRATE_BPS) {
            (base - 1_000).coerceAtLeast(MIN_BITRATE_BPS)
        } else {
            base
        }
    }

    /**
     * Determines the static-frame keepalive interval: `250ms` during the first 3s startup and
     * ~1s post-motion settle window, backing off to `1500ms` once idle to prevent VBV-draining spam.
     */
    fun computeStaticPumpIntervalMs(
        sessionAgeMs: Long,
        sinceLastRealFrameMs: Long,
    ): Long = when {
        sessionAgeMs < STATIC_PUMP_STARTUP_WINDOW_MS -> STATIC_PUMP_FAST_INTERVAL_MS
        sinceLastRealFrameMs < STATIC_PUMP_POST_MOTION_SETTLE_MS -> STATIC_PUMP_FAST_INTERVAL_MS
        else -> STATIC_PUMP_IDLE_INTERVAL_MS
    }

    fun minBitrateForResolution(width: Int, height: Int): Int {
        val shortEdge = minOf(width, height)
        return when {
            shortEdge >= 1080 -> 500_000
            shortEdge >= 800 -> 400_000
            shortEdge >= 720 -> 350_000
            else -> MIN_BITRATE_BPS
        }
    }

    /**
     * WAN/TURN-friendly minimum bitrate floor (`15%` of preset max, clamped to `[300, 600] kbps`)
     * shared by SDP `x-google-min-bitrate` and `RtpParameters` `encoding.minBitrateBps`.
     */
    fun computeSdpMinBitrateKbps(presetMaxKbps: Int): Int =
        ((presetMaxKbps * 15) / 100).coerceIn(300, 600)

    /**
     * Conservative initial bitrate (`35%` of preset max, clamped to `[1000, 2000] kbps`) for SDP
     * `x-google-start-bitrate` so even second #1 over a bandwidth-capped 3 Mbps cloud TURN VPS
     * never overflows its hypervisor FIFO, while LAN P2P ramps to 4.5-7.5 Mbps within ~1s.
     */
    fun computeSdpStartBitrateKbps(presetMaxKbps: Int): Int =
        ((presetMaxKbps * 35) / 100).coerceIn(1_000, 2_000)

    /**
     * Applies a route-aware maximum bitrate ceiling:
     * - Direct LAN / P2P (`!isTurnRelay`): keeps [presetMaxKbps] unchanged.
     * - Cloud TURN relay (`isTurnRelay`): caps below a 3 Mbps VPS egress limit so hypervisor FIFO
     *   bufferbloat never builds up while keeping 60fps UI text crisp.
     */
    fun computeRouteMaxBitrateKbps(presetMaxKbps: Int, isTurnRelay: Boolean): Int {
        if (!isTurnRelay) return presetMaxKbps
        return when {
            presetMaxKbps >= 6_000 -> minOf(presetMaxKbps, 2_500)
            presetMaxKbps >= 3_000 -> minOf(presetMaxKbps, 2_100)
            else -> minOf(presetMaxKbps, 1_200)
        }
    }

    /**
     * Selects the H.264 AVC codec level matching the target resolution and VPU operating rate.
     *
     * - 20:9 HD (`1080x2414` = 10,268 MBs * 120fps = 1,232,160 MB/s > Level 5.1 MaxMBPS 983,040)
     *   requires `AVCLevel52` so strict Codec2 HALs never reject `KEY_LATENCY = 1` + `KEY_OPERATING_RATE`.
     * - 20:9 BALANCED (`900x2012` * 120 = 861,840 MB/s) and 16:9 1080p (`1080x1920` * 120 = 979,200 MB/s)
     *   require `AVCLevel51`.
     * - 720p and ECO fit within `AVCLevel42`.
     */
    fun selectAvcLevel(width: Int, height: Int, targetFps: Int): Int {
        val mbW = ((width.coerceAtLeast(16) + 15) / 16).toLong()
        val mbH = ((height.coerceAtLeast(16) + 15) / 16).toLong()
        val mbPerFrame = mbW * mbH
        val effectiveRate = maxOf(targetFps, OPERATING_RATE_FPS).toLong()
        val mbPerSec = mbPerFrame * effectiveRate
        return when {
            mbPerSec > AVC_LEVEL_51_MAX_MBPS -> MediaCodecInfo.CodecProfileLevel.AVCLevel52
            mbPerFrame > AVC_LEVEL_42_MAX_FS_MB || mbPerSec > AVC_LEVEL_42_MAX_MBPS ->
                MediaCodecInfo.CodecProfileLevel.AVCLevel51
            else -> MediaCodecInfo.CodecProfileLevel.AVCLevel42
        }
    }

    /**
     * Selects the optimal H.264 profile supported by the hardware encoder for zero-reorder streaming.
     *
     * On API 27+ (`Build.VERSION_CODES.O_MR1`), prefers `AVCProfileConstrainedHigh` over plain
     * `AVCProfileHigh` when High profile is requested (avoids 2-4 frame decoder DPB reorder lag!),
     * falling back to `AVCProfileHigh`, `AVCProfileConstrainedBaseline`, or `AVCProfileBaseline`.
     */
    @SuppressLint("InlinedApi")
    fun selectAvcProfile(
        useHighProfile: Boolean,
        supportedProfiles: Set<Int>,
        sdkInt: Int = Build.VERSION.SDK_INT,
    ): Int {
        val supportsApi27Constrained = sdkInt >= Build.VERSION_CODES.O_MR1
        val constrainedHigh = if (supportsApi27Constrained) {
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh
        } else {
            -1
        }
        val constrainedBaseline = if (supportsApi27Constrained) {
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline
        } else {
            -1
        }
        val high = MediaCodecInfo.CodecProfileLevel.AVCProfileHigh
        val baseline = MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline

        if (useHighProfile) {
            if (supportedProfiles.isEmpty()) return high
            return when {
                constrainedHigh > 0 && constrainedHigh in supportedProfiles -> constrainedHigh
                high in supportedProfiles -> high
                constrainedBaseline > 0 && constrainedBaseline in supportedProfiles -> constrainedBaseline
                baseline in supportedProfiles -> baseline
                else -> high
            }
        }
        if (supportedProfiles.isEmpty()) return baseline
        return when {
            constrainedBaseline > 0 && constrainedBaseline in supportedProfiles -> constrainedBaseline
            baseline in supportedProfiles -> baseline
            else -> baseline
        }
    }

    /**
     * Resolves [desiredLevel] against the levels advertised in `CodecCapabilities.profileLevels`
     * for the target profile. Returns [desiredLevel] when supported (`maxSupported >= desiredLevel`),
     * falls back to the highest supported level if capped lower, or returns `null` so the caller
     * omits `KEY_LEVEL` and lets the HAL pick automatically.
     */
    fun resolveSupportedAvcLevel(
        desiredLevel: Int,
        supportedLevelsForProfile: Collection<Int>,
    ): Int? {
        val maxSupported = supportedLevelsForProfile.filter { it > 0 }.maxOrNull() ?: return null
        return if (maxSupported >= desiredLevel) desiredLevel else maxSupported
    }

    fun clampBitrateBps(requestedBps: Int, minFloorBps: Int = MIN_BITRATE_BPS): Int {
        val floor = minFloorBps.coerceIn(MIN_BITRATE_BPS, MAX_BITRATE_BPS)
        return requestedBps.coerceIn(floor, MAX_BITRATE_BPS)
    }

    fun shouldApplyBitrateUpdate(
        currentBps: Int,
        targetBps: Int,
        elapsedSinceLastUpdateMs: Long,
    ): Boolean {
        if (currentBps <= 0) return true
        if (elapsedSinceLastUpdateMs < BITRATE_UPDATE_MIN_INTERVAL_MS) return false
        val delta = abs(targetBps - currentBps).toDouble()
        return (delta / currentBps.toDouble()) >= BITRATE_CHANGE_THRESHOLD_RATIO
    }

    fun shouldAllowKeyframeRequest(
        explicitRequested: Boolean,
        elapsedSinceLastKeyMs: Long,
        hasSentAnyKeyframe: Boolean,
    ): Boolean {
        if (!explicitRequested) return false
        if (!hasSentAnyKeyframe) return true
        return elapsedSinceLastKeyMs >= MIN_KEYFRAME_INTERVAL_MS
    }

    /**
     * Checks whether an Annex-B H.264 access unit already contains an SPS NAL unit (type 7)
     * near its beginning (scanning past leading AUD/SEI NALs up to 512 bytes) so we avoid
     * duplicating SPS/PPS when `KEY_PREPEND_HEADER_TO_SYNC_FRAMES` is supported by the HAL.
     */
    fun startsWithSpsNal(bytes: ByteArray, length: Int = bytes.size): Boolean {
        val limit = length.coerceAtMost(bytes.size).coerceAtMost(SPS_SCAN_LIMIT_BYTES)
        var i = 0
        while (i + 3 < limit) {
            if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte()) {
                val nalIndex = when {
                    bytes[i + 2] == 1.toByte() -> i + 3
                    bytes[i + 2] == 0.toByte() && i + 4 < limit && bytes[i + 3] == 1.toByte() -> i + 4
                    else -> -1
                }
                if (nalIndex in 0 until limit) {
                    val nalType = bytes[nalIndex].toInt() and 0x1F
                    if (nalType == 7) return true
                    // If first slice NAL is IDR (5) or non-IDR slice (1), SPS is NOT prepended
                    if (nalType == 5 || nalType == 1) return false
                    i = nalIndex + 1
                    continue
                }
            }
            i++
        }
        return false
    }

    fun buildOutputBytesWithConfigIfNeeded(
        frameBytes: ByteArray,
        isKeyFrame: Boolean,
        cachedConfig: ByteArray?,
    ): ByteArray {
        if (!isKeyFrame || cachedConfig == null || cachedConfig.isEmpty()) {
            return frameBytes
        }
        if (startsWithSpsNal(frameBytes)) {
            return frameBytes
        }
        val combined = ByteArray(cachedConfig.size + frameBytes.size)
        System.arraycopy(cachedConfig, 0, combined, 0, cachedConfig.size)
        System.arraycopy(frameBytes, 0, combined, cachedConfig.size, frameBytes.size)
        return combined
    }
}

/**
 * Pure, Android-free RTT-reactive bufferbloat backoff state machine.
 *
 * Tracks the session's empty-queue baseline RTT floor (`[10, 120] ms` initial clamp, lowered on
 * subsequent calmer samples down to `10 ms`) and dynamically scales down sender bitrate when
 * queueing delay spikes (`excess >= 65 ms` or absolute `rttMs >= 180 ms`), holds steady on
 * moderate incipient queueing (`excess >= 35 ms` or `rttMs >= 140 ms`), and gradually recovers
 * (`+0.10` per 3 consecutive calm 1-second polls) once queues drain.
 */
internal class RttCongestionGuard {
    var baselineRttMs: Int? = null
        private set
    var scale: Double = 1.0
        private set
    var calmStreak: Int = 0
        private set

    fun reset() {
        baselineRttMs = null
        scale = 1.0
        calmStreak = 0
    }

    fun onRttSample(rttMs: Int): Double {
        if (rttMs <= 0) return scale

        val currentBaseline = baselineRttMs
        val baseline = when {
            currentBaseline == null -> rttMs.coerceIn(MIN_BASELINE_RTT_MS, MAX_INITIAL_BASELINE_RTT_MS)
            rttMs < currentBaseline -> maxOf(MIN_BASELINE_RTT_MS, rttMs)
            else -> currentBaseline
        }
        baselineRttMs = baseline

        val excess = rttMs - baseline
        when {
            // Fast bufferbloat cut: drop aggressively before cloud VPS FIFO explodes
            excess >= FAST_CUT_EXCESS_MS || rttMs >= FAST_CUT_ABSOLUTE_RTT_MS -> {
                calmStreak = 0
                scale = roundScale((scale * FAST_CUT_FACTOR).coerceAtLeast(MIN_SCALE))
            }

            // Moderate elevated RTT: hold current scale instead of probing into incipient queue
            excess >= HOLD_EXCESS_MS || rttMs >= HOLD_ABSOLUTE_RTT_MS -> {
                calmStreak = 0
            }

            // Calm link: gradually recover after 3 consecutive calm samples
            else -> {
                calmStreak = (calmStreak + 1).coerceAtMost(1_000_000)
                if (calmStreak >= RECOVERY_CALM_STREAK && scale < 1.0) {
                    scale = roundScale((scale + RECOVERY_STEP).coerceAtMost(1.0))
                    calmStreak = 0
                }
            }
        }
        return scale
    }

    fun applyScale(routeMaxKbps: Int, scale: Double): Int =
        (routeMaxKbps * scale).toInt().coerceIn(MIN_SCALED_KBPS, routeMaxKbps.coerceAtLeast(MIN_SCALED_KBPS))

    private fun roundScale(value: Double): Double = round(value * 1_000_000.0) / 1_000_000.0

    companion object {
        const val MIN_BASELINE_RTT_MS = 10
        const val MAX_INITIAL_BASELINE_RTT_MS = 120
        const val FAST_CUT_EXCESS_MS = 65
        const val FAST_CUT_ABSOLUTE_RTT_MS = 180
        const val HOLD_EXCESS_MS = 35
        const val HOLD_ABSOLUTE_RTT_MS = 140
        const val FAST_CUT_FACTOR = 0.70
        const val MIN_SCALE = 0.35
        const val RECOVERY_CALM_STREAK = 3
        const val RECOVERY_STEP = 0.10
        const val MIN_SCALED_KBPS = 600
    }
}

/**
 * Hysteretic auto-mode resolution & ceiling tiers (RustDesk `video_qos.rs` principles).
 */
internal enum class AutoResolutionTier(
    val maxWidth: Int,
    val nominalFps: Int,
    val p2pCeilingKbps: Int,
    val turnCeilingKbps: Int,
) {
    LOW(540, 30, 1_400, 950),        // weak cellular / severe congestion
    SMOOTH(720, 45, 2_800, 1_500),   // moderate WAN / constrained TURN
    BALANCED(900, 60, 4_500, 2_100), // fast TURN / normal Wi-Fi
    ULTRA(1080, 60, 7_500, 2_500);   // fast LAN P2P (>= 5.5 Mbps)

    fun ceilingKbps(isTurnRelay: Boolean): Int =
        if (isTurnRelay) turnCeilingKbps else p2pCeilingKbps

    companion object {
        fun forMaxWidth(maxWidth: Int): AutoResolutionTier = when {
            maxWidth >= ULTRA.maxWidth -> ULTRA
            maxWidth >= BALANCED.maxWidth -> BALANCED
            maxWidth >= SMOOTH.maxWidth -> SMOOTH
            else -> LOW
        }
    }
}

/**
 * 1-second telemetry snapshot fed into [AdaptiveQoSController].
 */
internal data class QosSample(
    val rttMs: Int?,
    val bweKbps: Long?,
    val sendRateKbps: Long,
    val currentFps: Double,
    val retxDelta: Long,
    val isTurnRelay: Boolean,
    val autoMode: Boolean,
    val baseQuality: StreamQuality,
    val nowElapsedMs: Long,
)

/**
 * Actionable encoder/sender target emitted by [AdaptiveQoSController].
 */
internal data class QosDecision(
    val maxBitrateKbps: Int,
    val maxFps: Int,
    val targetMaxWidth: Int,
    val resolutionChanged: Boolean,
    val reason: String?,
)

/**
 * Pure, Android-free RustDesk-inspired (`src/server/video_qos.rs`) adaptive video QoS controller.
 *
 * Implements:
 * 1. **20-sample sliding baseline RTT window** (`RttCalculator`): tightens immediately on lower
 *    RTTs and naturally expires stale Wi-Fi minima after 20 fresh samples during Wi-Fi -> 5G handoff.
 * 2. **2-stage Bitrate-First -> FPS-Second congestion control** with single-jitter immunity
 *    (RustDesk PR #16082), immediate emergency cuts (`excess >= 220ms || rtt >= 300ms`), and
 *    retransmission-burst awareness (`retxDelta >= 12`).
 * 3. **Dynamic-screen guard** (`currentFps >= 3.0 || sendRateKbps >= 180`): prevents static idle
 *    screens from inflating quality only to burst on motion.
 * 4. **Startup acceleration** (`auto` mode): opens cleanly at `1.5-1.8 Mbps` and ramps rapidly on
 *    2 consecutive clean samples (`excess < 40ms && retxDelta <= 2`).
 * 5. **Fast-restore with 5-sample rollback guard**: jumps FPS/bitrate back toward pre-congestion
 *    levels once queues clear, rolling back immediately if congestion returns within 5 samples.
 * 6. **Hysteretic auto resolution scaling** (`autoMode == true` only, strict `8_000ms` cooldown):
 *    switches smoothly across `LOW (540p)` / `SMOOTH (720p)` / `BALANCED (900p)` / `ULTRA (1080p)`
 *    while manual modes (`autoMode == false`) NEVER alter user-selected resolution.
 */
internal class AdaptiveQoSController {
    private val rttWindow = ArrayDeque<Int>(RTT_WINDOW_SIZE)

    var baselineRttMs: Int? = null
        private set
    var bitrateScale: Double = 1.0
        private set
    var targetFps: Int = 60
        private set
    var currentTier: AutoResolutionTier = AutoResolutionTier.BALANCED
        private set
    var startupActive: Boolean = false
        private set
    var badStreak: Int = 0
        private set
    var cleanStreak: Int = 0
        private set
    var lowBwStreak: Int = 0
        private set
    var samplesSinceRestore: Int? = null
        private set

    private var initialized: Boolean = false
    private var lastAutoMode: Boolean = false
    private var lastBaseMaxWidth: Int = 0
    private var lastBaseFps: Int = 60
    private var lastBaseBitrateKbps: Int = 0
    private var lastIsTurnRelay: Boolean = false
    private var startupCleanStreak: Int = 0
    private var recoveryCleanStreak: Int = 0
    private var preCongestionScale: Double? = null
    private var preCongestionFps: Int? = null
    private var lastRestoreScale: Double = 1.0
    private var lastRestoreFps: Int = 60
    private var lastResolutionChangeMs: Long = Long.MIN_VALUE
    private var explicitResetElapsedMs: Long = Long.MIN_VALUE

    fun reset(nowElapsedMs: Long = Long.MIN_VALUE) {
        rttWindow.clear()
        baselineRttMs = null
        bitrateScale = 1.0
        targetFps = 60
        currentTier = AutoResolutionTier.BALANCED
        startupActive = false
        badStreak = 0
        cleanStreak = 0
        lowBwStreak = 0
        samplesSinceRestore = null
        initialized = false
        lastAutoMode = false
        lastBaseMaxWidth = 0
        lastBaseFps = 60
        lastBaseBitrateKbps = 0
        lastIsTurnRelay = false
        startupCleanStreak = 0
        recoveryCleanStreak = 0
        preCongestionScale = null
        preCongestionFps = null
        lastRestoreScale = 1.0
        lastRestoreFps = 60
        lastResolutionChangeMs = nowElapsedMs
        explicitResetElapsedMs = nowElapsedMs
    }

    fun onSample(sample: QosSample): QosDecision {
        var initResolutionChanged = false
        var reason: String? = null

        val presetChanged = !initialized ||
            sample.autoMode != lastAutoMode ||
            (!sample.autoMode && (
                sample.baseQuality.maxWidth != lastBaseMaxWidth ||
                    sample.baseQuality.fps != lastBaseFps ||
                    sample.baseQuality.bitrateKbps != lastBaseBitrateKbps
                ))

        if (presetChanged) {
            initialized = true
            lastAutoMode = sample.autoMode
            lastBaseMaxWidth = sample.baseQuality.maxWidth
            lastBaseFps = sample.baseQuality.fps
            lastBaseBitrateKbps = sample.baseQuality.bitrateKbps
            lastIsTurnRelay = sample.isTurnRelay
            badStreak = 0
            cleanStreak = 0
            recoveryCleanStreak = 0
            lowBwStreak = 0
            preCongestionScale = null
            preCongestionFps = null
            samplesSinceRestore = null
            startupCleanStreak = 0

            if (sample.autoMode) {
                currentTier = if (sample.isTurnRelay) {
                    AutoResolutionTier.SMOOTH
                } else {
                    AutoResolutionTier.forMaxWidth(sample.baseQuality.maxWidth)
                }
                targetFps = currentTier.nominalFps
                val startKbps = if (sample.isTurnRelay) {
                    AUTO_TURN_START_BITRATE_KBPS
                } else {
                    AUTO_P2P_START_BITRATE_KBPS
                }
                val ceiling = currentTier.ceilingKbps(sample.isTurnRelay)
                bitrateScale = roundScale(
                    (startKbps.toDouble() / ceiling.toDouble()).coerceIn(MIN_BITRATE_SCALE, 1.0),
                )
                startupActive = bitrateScale < 1.0
                if (currentTier.maxWidth != sample.baseQuality.maxWidth) {
                    initResolutionChanged = true
                    reason = "AUTO_INIT_${currentTier.name}"
                    lastResolutionChangeMs = sample.nowElapsedMs
                } else {
                    lastResolutionChangeMs = if (explicitResetElapsedMs != Long.MIN_VALUE) {
                        explicitResetElapsedMs
                    } else {
                        sample.nowElapsedMs
                    }
                }
            } else {
                currentTier = AutoResolutionTier.forMaxWidth(sample.baseQuality.maxWidth)
                targetFps = resolveManualTargetFps(sample.baseQuality)
                bitrateScale = 1.0
                startupActive = false
                lastResolutionChangeMs = sample.nowElapsedMs
            }
        } else if (sample.isTurnRelay != lastIsTurnRelay) {
            // Re-normalize startup scale on P2P -> TURN handoff so startup bitrate stays in 1.5 Mbps range
            if (sample.autoMode && sample.isTurnRelay && startupActive) {
                val prevCeiling = currentTier.ceilingKbps(false)
                val newCeiling = currentTier.ceilingKbps(true)
                val prevEffective = (prevCeiling * bitrateScale).toInt()
                val targetStart = minOf(maxOf(prevEffective, AUTO_TURN_START_BITRATE_KBPS), newCeiling)
                bitrateScale = roundScale(
                    (targetStart.toDouble() / newCeiling.toDouble()).coerceIn(MIN_BITRATE_SCALE, 1.0),
                )
                if (bitrateScale >= 1.0) {
                    startupActive = false
                }
            }
            lastIsTurnRelay = sample.isTurnRelay
        }

        // 1. Update 20-sample sliding baseline RTT window (RustDesk RttCalculator)
        val rtt = sample.rttMs?.takeIf { it > 0 }
        if (rtt != null) {
            if (rttWindow.size >= RTT_WINDOW_SIZE) {
                rttWindow.removeFirst()
            }
            rttWindow.addLast(rtt)
            var minSample = Int.MAX_VALUE
            for (v in rttWindow) {
                if (v < minSample) minSample = v
            }
            baselineRttMs = minSample.coerceIn(MIN_BASELINE_RTT_MS, MAX_BASELINE_RTT_MS)
        }
        val baseline = baselineRttMs
        val excessMs = if (rtt != null && baseline != null) {
            (rtt - baseline).coerceAtLeast(0)
        } else {
            0
        }

        // 2. Classify motion & network sample health
        val retxDelta = sample.retxDelta.coerceAtLeast(0L)
        val isActiveMotion = sample.currentFps >= DYNAMIC_SCREEN_MIN_FPS ||
            sample.sendRateKbps >= DYNAMIC_SCREEN_MIN_KBPS
        val ceilingFps = if (sample.autoMode) {
            currentTier.nominalFps
        } else {
            resolveManualTargetFps(sample.baseQuality)
        }
        val minFps = if (sample.autoMode) MIN_AUTO_FPS else MIN_MANUAL_FPS
        val fpsStep = maxOf(6, round(ceilingFps * FPS_REDUCTION_RATIO).toInt())

        val isSevereEmergency = rtt != null &&
            (excessMs >= SEVERE_EXCESS_MS || rtt >= SEVERE_ABSOLUTE_RTT_MS)
        val isBadSample = isSevereEmergency ||
            (rtt != null && (excessMs >= BAD_EXCESS_MS || rtt >= BAD_ABSOLUTE_RTT_MS)) ||
            retxDelta >= BAD_RETX_DELTA
        val isStartupClean = !isBadSample &&
            (rtt != null && excessMs < STARTUP_CLEAN_EXCESS_MS && rtt < BAD_ABSOLUTE_RTT_MS) &&
            retxDelta <= CLEAN_MAX_RETX_DELTA
        val isCleanSample = !isBadSample &&
            (rtt != null && excessMs <= CLEAN_EXCESS_MS && rtt < CLEAN_MAX_ABSOLUTE_RTT_MS) &&
            retxDelta <= CLEAN_MAX_RETX_DELTA

        // 3. Bitrate-first -> FPS-second congestion control, startup accel, fast-restore & rollback guard
        if (isBadSample) {
            badStreak = (badStreak + 1).coerceAtMost(1_000_000)
            cleanStreak = 0
            recoveryCleanStreak = 0
            startupActive = false
            startupCleanStreak = 0

            val withinRestoreGuard = samplesSinceRestore != null &&
                samplesSinceRestore!! < RESTORE_GUARD_SAMPLES
            if (withinRestoreGuard) {
                bitrateScale = roundScale(
                    minOf(bitrateScale, lastRestoreScale).coerceAtLeast(MIN_BITRATE_SCALE),
                )
                if (isSevereEmergency) {
                    bitrateScale = roundScale(
                        (bitrateScale * SEVERE_CUT_FACTOR).coerceAtLeast(MIN_BITRATE_SCALE),
                    )
                }
                targetFps = minOf(targetFps, lastRestoreFps).coerceIn(minFps, ceilingFps)
                samplesSinceRestore = null
                preCongestionScale = null
                preCongestionFps = null
                reason = "RESTORE_ROLLBACK"
            } else if (isSevereEmergency) {
                if (preCongestionScale == null) {
                    preCongestionScale = bitrateScale
                    preCongestionFps = targetFps
                }
                bitrateScale = roundScale(
                    (bitrateScale * SEVERE_CUT_FACTOR).coerceAtLeast(MIN_BITRATE_SCALE),
                )
                if (badStreak >= FPS_CUT_BAD_STREAK &&
                    (bitrateScale <= FPS_CUT_SCALE_THRESHOLD || excessMs >= FPS_CUT_SEVERE_EXCESS_MS)
                ) {
                    targetFps = (targetFps - fpsStep).coerceAtLeast(minFps)
                    reason = "EMERGENCY_BITRATE_AND_FPS_CUT"
                } else {
                    reason = "EMERGENCY_BITRATE_CUT"
                }
            } else if (badStreak == 1) {
                // Single jitter hiccup (< 220ms excess): hold steady (RustDesk PR #16082)
                reason = reason ?: "JITTER_HOLD"
            } else {
                if (preCongestionScale == null) {
                    preCongestionScale = bitrateScale
                    preCongestionFps = targetFps
                }
                val cutFactor = if (badStreak >= 3) {
                    SUSTAINED_BAD_CUT_FACTOR
                } else {
                    CONFIRMED_BAD_CUT_FACTOR
                }
                bitrateScale = roundScale(
                    (bitrateScale * cutFactor).coerceAtLeast(MIN_BITRATE_SCALE),
                )
                if (badStreak >= FPS_CUT_BAD_STREAK &&
                    (bitrateScale <= FPS_CUT_SCALE_THRESHOLD || excessMs >= FPS_CUT_SEVERE_EXCESS_MS)
                ) {
                    targetFps = (targetFps - fpsStep).coerceAtLeast(minFps)
                    reason = "CONGESTION_BITRATE_AND_FPS_CUT"
                } else {
                    reason = "CONGESTION_BITRATE_CUT"
                }
            }
        } else {
            badStreak = 0
            // Advance post-restore watch counter
            if (samplesSinceRestore != null) {
                val nextCount = samplesSinceRestore!! + 1
                samplesSinceRestore = if (nextCount >= RESTORE_GUARD_SAMPLES) null else nextCount
            }

            // Startup acceleration in auto mode (allowed while startupActive == true)
            if (startupActive) {
                if (isStartupClean) {
                    startupCleanStreak++
                    if (startupCleanStreak >= STARTUP_CLEAN_STREAK) {
                        bitrateScale = roundScale((bitrateScale + STARTUP_ACCEL_STEP).coerceAtMost(1.0))
                        reason = reason ?: "STARTUP_ACCEL"
                        if (bitrateScale >= 1.0) {
                            startupActive = false
                        }
                    }
                } else {
                    startupCleanStreak = 0
                }
            }

            if (isCleanSample) {
                if (isActiveMotion) {
                    cleanStreak = (cleanStreak + 1).coerceAtMost(1_000_000)
                }
                if (isActiveMotion && !startupActive) {
                    recoveryCleanStreak = (recoveryCleanStreak + 1).coerceAtMost(1_000_000)
                    val savedFps = preCongestionFps
                    val savedScale = preCongestionScale
                    val needsFpsRestore = savedFps != null && targetFps < minOf(savedFps, ceilingFps)
                    val needsScaleRestore = savedScale != null && bitrateScale < savedScale

                    if ((needsFpsRestore || needsScaleRestore) &&
                        recoveryCleanStreak >= FAST_RESTORE_CLEAN_STREAK
                    ) {
                        lastRestoreFps = targetFps
                        lastRestoreScale = bitrateScale
                        if (savedFps != null && targetFps < minOf(savedFps, ceilingFps)) {
                            targetFps = minOf(savedFps, ceilingFps)
                        }
                        if (savedScale != null && bitrateScale < savedScale) {
                            val boosted = maxOf(
                                bitrateScale + FAST_RESTORE_SCALE_BOOST,
                                (bitrateScale + savedScale) / 2.0,
                            )
                            bitrateScale = roundScale(minOf(savedScale, boosted).coerceAtMost(1.0))
                        }
                        samplesSinceRestore = 0
                        preCongestionFps = null
                        preCongestionScale = null
                        recoveryCleanStreak = 0
                        reason = "FAST_RESTORE"
                    } else if (recoveryCleanStreak >= RECOVERY_CLEAN_STREAK) {
                        var recovered = false
                        if (targetFps < ceilingFps) {
                            targetFps = (targetFps + fpsStep).coerceAtMost(ceilingFps)
                            recovered = true
                        }
                        if (bitrateScale < 1.0) {
                            bitrateScale = roundScale(
                                (bitrateScale + RECOVERY_SCALE_STEP).coerceAtMost(1.0),
                            )
                            recovered = true
                        }
                        if (recovered) {
                            recoveryCleanStreak = 0
                            reason = reason ?: "RECOVERY"
                        }
                    }
                }
            } else {
                // Moderate/hold sample: reset clean streaks without cutting
                cleanStreak = 0
                recoveryCleanStreak = 0
            }
        }

        // 4. Hysteretic resolution scaling (ONLY when autoMode == true, strict 8_000ms cooldown)
        var resolutionChanged = initResolutionChanged
        var effectiveBitrateKbps = computeEffectiveBitrateKbps(sample, currentTier, bitrateScale)

        if (sample.autoMode) {
            val bwe = sample.bweKbps?.takeIf { it > 0L }
            val desiredDowngradeTier: AutoResolutionTier? = when {
                effectiveBitrateKbps < LOW_DOWNGRADE_BITRATE_KBPS ||
                    (bwe != null && bwe < LOW_DOWNGRADE_BITRATE_KBPS) ->
                    AutoResolutionTier.LOW
                effectiveBitrateKbps < SMOOTH_DOWNGRADE_BITRATE_KBPS ||
                    (bwe != null && bwe < SMOOTH_DOWNGRADE_BITRATE_KBPS) ->
                    AutoResolutionTier.SMOOTH
                sample.isTurnRelay && currentTier == AutoResolutionTier.ULTRA ->
                    AutoResolutionTier.BALANCED
                else -> null
            }
            val needsDowngrade = desiredDowngradeTier != null &&
                desiredDowngradeTier.ordinal < currentTier.ordinal

            if (isBadSample || needsDowngrade) {
                lowBwStreak = (lowBwStreak + 1).coerceAtMost(1_000_000)
            } else {
                lowBwStreak = 0
            }

            val cooldownElapsed = lastResolutionChangeMs == Long.MIN_VALUE ||
                (sample.nowElapsedMs - lastResolutionChangeMs) >= RESOLUTION_COOLDOWN_MS

            if (!initResolutionChanged && cooldownElapsed) {
                if (needsDowngrade && lowBwStreak >= DOWNGRADE_BAD_STREAK) {
                    val newTier = desiredDowngradeTier!!
                    val newCeiling = newTier.ceilingKbps(sample.isTurnRelay)
                    currentTier = newTier
                    targetFps = newTier.nominalFps
                    bitrateScale = roundScale(
                        (effectiveBitrateKbps.toDouble() / newCeiling.toDouble())
                            .coerceIn(MIN_BITRATE_SCALE, 1.0),
                    )
                    effectiveBitrateKbps = computeEffectiveBitrateKbps(sample, currentTier, bitrateScale)
                    lastResolutionChangeMs = sample.nowElapsedMs
                    lowBwStreak = 0
                    cleanStreak = 0
                    recoveryCleanStreak = 0
                    badStreak = 0
                    preCongestionScale = null
                    preCongestionFps = null
                    samplesSinceRestore = null
                    startupActive = false
                    resolutionChanged = true
                    reason = "AUTO_RES_DOWN_${newTier.name}"
                } else if (isActiveMotion && isCleanSample && cleanStreak >= UPGRADE_CLEAN_STREAK && !needsDowngrade) {
                    val bweVal = bwe ?: 0L
                    val desiredUpgradeTier = when {
                        !sample.isTurnRelay &&
                            bweVal >= ULTRA_UPGRADE_BWE_KBPS &&
                            bitrateScale >= ULTRA_UPGRADE_MIN_SCALE ->
                            AutoResolutionTier.ULTRA
                        (!sample.isTurnRelay &&
                            bweVal >= BALANCED_P2P_UPGRADE_BWE_KBPS &&
                            bitrateScale >= BALANCED_P2P_UPGRADE_MIN_SCALE) ||
                            (sample.isTurnRelay &&
                                bitrateScale >= BALANCED_TURN_UPGRADE_MIN_SCALE &&
                                isCleanSample &&
                                bweVal >= BALANCED_TURN_UPGRADE_BWE_KBPS) ->
                            AutoResolutionTier.BALANCED
                        bweVal >= SMOOTH_UPGRADE_BWE_KBPS &&
                            bitrateScale >= SMOOTH_UPGRADE_MIN_SCALE ->
                            AutoResolutionTier.SMOOTH
                        else -> currentTier
                    }
                    if (desiredUpgradeTier.ordinal > currentTier.ordinal) {
                        val nextTier = AutoResolutionTier.entries[currentTier.ordinal + 1]
                        currentTier = nextTier
                        targetFps = nextTier.nominalFps
                        effectiveBitrateKbps = computeEffectiveBitrateKbps(sample, currentTier, bitrateScale)
                        lastResolutionChangeMs = sample.nowElapsedMs
                        cleanStreak = 0
                        recoveryCleanStreak = 0
                        lowBwStreak = 0
                        preCongestionScale = null
                        preCongestionFps = null
                        samplesSinceRestore = null
                        resolutionChanged = true
                        reason = "AUTO_RES_UP_${nextTier.name}"
                    }
                }
            }
        } else {
            lowBwStreak = 0
        }

        val finalCeilingFps = if (sample.autoMode) {
            currentTier.nominalFps
        } else {
            resolveManualTargetFps(sample.baseQuality)
        }
        val finalTargetWidth = if (sample.autoMode) {
            currentTier.maxWidth
        } else {
            sample.baseQuality.maxWidth
        }
        targetFps = targetFps.coerceIn(minFps, finalCeilingFps)

        return QosDecision(
            maxBitrateKbps = effectiveBitrateKbps,
            maxFps = targetFps,
            targetMaxWidth = finalTargetWidth,
            resolutionChanged = resolutionChanged,
            reason = reason,
        )
    }

    private fun computeEffectiveBitrateKbps(
        sample: QosSample,
        tier: AutoResolutionTier,
        scale: Double,
    ): Int {
        val routeCeilingKbps = if (sample.autoMode) {
            tier.ceilingKbps(sample.isTurnRelay)
        } else {
            val presetMaxKbps = resolveManualBitrateKbps(sample.baseQuality)
            LowLatencyEncoderMath.computeRouteMaxBitrateKbps(presetMaxKbps, sample.isTurnRelay)
        }
        val targetWidth = if (sample.autoMode) tier.maxWidth else sample.baseQuality.maxWidth
        val resFloorKbps = LowLatencyEncoderMath.minBitrateForResolution(targetWidth, targetWidth) / 1_000
        val minFloorKbps = maxOf(MIN_EFFECTIVE_BITRATE_KBPS, resFloorKbps)
        return (routeCeilingKbps * scale)
            .toInt()
            .coerceIn(minFloorKbps, routeCeilingKbps.coerceAtLeast(minFloorKbps))
    }

    private fun roundScale(value: Double): Double = round(value * 1_000_000.0) / 1_000_000.0

    companion object {
        const val RTT_WINDOW_SIZE = 20
        const val MIN_BASELINE_RTT_MS = 10
        const val MAX_BASELINE_RTT_MS = 150

        const val DYNAMIC_SCREEN_MIN_FPS = 3.0
        const val DYNAMIC_SCREEN_MIN_KBPS = 180L

        const val AUTO_P2P_START_BITRATE_KBPS = 1_800
        const val AUTO_TURN_START_BITRATE_KBPS = 1_500
        const val STARTUP_CLEAN_EXCESS_MS = 40
        const val STARTUP_CLEAN_STREAK = 2
        const val STARTUP_ACCEL_STEP = 0.30

        const val SEVERE_EXCESS_MS = 220
        const val SEVERE_ABSOLUTE_RTT_MS = 300
        const val SEVERE_CUT_FACTOR = 0.60

        const val BAD_EXCESS_MS = 65
        const val BAD_ABSOLUTE_RTT_MS = 180
        const val BAD_RETX_DELTA = 12L
        const val CONFIRMED_BAD_CUT_FACTOR = 0.75
        const val SUSTAINED_BAD_CUT_FACTOR = 0.65
        const val MIN_BITRATE_SCALE = 0.30

        const val FPS_CUT_BAD_STREAK = 3
        const val FPS_CUT_SCALE_THRESHOLD = 0.65
        const val FPS_CUT_SEVERE_EXCESS_MS = 250
        const val FPS_REDUCTION_RATIO = 0.20
        const val MIN_AUTO_FPS = 20
        const val MIN_MANUAL_FPS = 24

        const val CLEAN_EXCESS_MS = 30
        const val CLEAN_MAX_ABSOLUTE_RTT_MS = 140
        const val CLEAN_MAX_RETX_DELTA = 2L
        const val FAST_RESTORE_CLEAN_STREAK = 2
        const val FAST_RESTORE_SCALE_BOOST = 0.15
        const val RESTORE_GUARD_SAMPLES = 5
        const val RECOVERY_CLEAN_STREAK = 2
        const val RECOVERY_SCALE_STEP = 0.10

        const val RESOLUTION_COOLDOWN_MS = 8_000L
        const val UPGRADE_CLEAN_STREAK = 5
        const val DOWNGRADE_BAD_STREAK = 4
        const val ULTRA_UPGRADE_BWE_KBPS = 5_500L
        const val ULTRA_UPGRADE_MIN_SCALE = 0.95
        const val BALANCED_P2P_UPGRADE_BWE_KBPS = 2_400L
        const val BALANCED_P2P_UPGRADE_MIN_SCALE = 0.80
        const val BALANCED_TURN_UPGRADE_BWE_KBPS = 1_800L
        const val BALANCED_TURN_UPGRADE_MIN_SCALE = 0.90
        const val SMOOTH_UPGRADE_BWE_KBPS = 1_100L
        const val SMOOTH_UPGRADE_MIN_SCALE = 0.80
        const val LOW_DOWNGRADE_BITRATE_KBPS = 950
        const val SMOOTH_DOWNGRADE_BITRATE_KBPS = 1_550
        const val MIN_EFFECTIVE_BITRATE_KBPS = 350

        fun resolveManualTargetFps(quality: StreamQuality): Int {
            val boosted = if (quality.maxWidth >= 720 && quality.fps in 24..30) 60 else quality.fps
            return boosted.coerceIn(MIN_MANUAL_FPS, 60)
        }

        fun resolveManualBitrateKbps(quality: StreamQuality): Int = when {
            quality.maxWidth >= 1080 -> quality.bitrateKbps.coerceIn(4_500, 8_000)
            quality.maxWidth >= 800 -> quality.bitrateKbps.coerceIn(3_000, 5_500)
            quality.maxWidth >= 720 -> quality.bitrateKbps.coerceIn(2_400, 4_200)
            else -> quality.bitrateKbps.coerceIn(900, 1_800)
        }

        fun initialStartBitrateKbps(quality: StreamQuality, isTurnRelay: Boolean): Int {
            if (quality.auto) {
                return if (isTurnRelay) AUTO_TURN_START_BITRATE_KBPS else AUTO_P2P_START_BITRATE_KBPS
            }
            return LowLatencyEncoderMath.computeRouteMaxBitrateKbps(
                resolveManualBitrateKbps(quality),
                isTurnRelay,
            )
        }
    }
}

/**
 * Industrial-grade zero-copy hardware H.264 [VideoEncoder] engineered specifically for
 * interactive 60fps remote Android control (inspired by scrcpy / Moonlight / Parsec):
 *
 * Root causes eliminated vs stock `stream-webrtc-android` `HardwareVideoEncoder`:
 * 1. **Clamped monotonic codec PTS** (`8-16.67ms` delta) while preserving real `captureTimeNs` on
 *    [EncodedImage]: eliminates the 205-275 KB Qualcomm CBR idle-gap monster keyframes and 88 KB
 *    idle-recovery P-frame bursts that poisoned `libwebrtc`'s `FrameDropper`.
 * 2. **True 60 FPS native rate control**: removes stock `HardwareVideoEncoder`'s hardcoded
 *    `MAX_VIDEO_FRAMERATE = 30` ceiling and broken `FramerateBitrateAdjuster`.
 * 3. **Hardware VPU low-latency tuning**: sets `KEY_LOW_LATENCY = 1` + `KEY_LATENCY = 1` (overrides
 *    Qualcomm `RequestedPipelineDelayTuningHelper` default `algo.delay=4`), `KEY_PRIORITY = 0`
 *    (realtime DSP priority), `KEY_OPERATING_RATE = 120`, `KEY_MAX_B_FRAMES = 0`, and
 *    `KEY_INTRA_REFRESH_PERIOD = 120` when supported.
 * 4. **Zero VPU output buffer starvation & zero 60fps off-heap churn**: copies encoded NAL bytes
 *    directly into a bounded pooled direct [ByteBuffer] and immediately releases the MediaCodec
 *    output slot on a `THREAD_PRIORITY_URGENT_DISPLAY` (`-8`) output thread.
 * 5. **No mid-session resolution teardown stalls**: returns [VideoEncoder.ScalingSettings.OFF]
 *    and tracks in-flight depth via self-healing `pendingMeta` (single source of truth).
 */
class LowLatencyH264Encoder(
    private val codecName: String,
    private val supportsIntraRefresh: Boolean,
    private val sharedContext: EglBase.Context,
    private val useHighProfile: Boolean = true,
    private val onReleased: ((LowLatencyH264Encoder) -> Unit)? = null,
) : VideoEncoder {

    private enum class ConfigTier(
        val label: String,
        val includeCbrAndCoreLowLatency: Boolean,
        val includeAggressiveLowLatency: Boolean,
        val includeProfileAndLevel: Boolean,
        val includeQpBounds: Boolean,
    ) {
        TIER_1("1", true, true, true, true),
        TIER_2("2", true, true, true, false),
        TIER_2B("2b", true, true, false, false),
        TIER_3("3", true, false, false, false),
        TIER_4("4", false, false, false, false),
    }

    private data class ConfiguredCodec(
        val tier: ConfigTier,
        val profile: Int,
    )

    private data class FrameMeta(
        val codecPtsUs: Long,
        val captureTimeNs: Long,
        val rotation: Int,
        val submitElapsedNs: Long,
    )

    private val metaLock = Any()
    private val pendingMeta = ArrayDeque<FrameMeta>(16)
    private val forceNextSyncFrame = AtomicBoolean(false)
    private val directBufferPool = ArrayBlockingQueue<ByteBuffer>(BUFFER_POOL_SIZE)

    private var callback: VideoEncoder.Callback? = null
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var encoderEgl: EglBase14? = null
    private var glRectDrawer: GlRectDrawer? = null
    private var videoFrameDrawer: VideoFrameDrawer? = null
    private var outputThread: Thread? = null

    @Volatile
    private var running: Boolean = false

    @Volatile
    private var width: Int = 0

    @Volatile
    private var height: Int = 0

    @Volatile
    private var targetFps: Int = 60

    @Volatile
    private var currentBitrateBps: Int = 2_400_000

    private var lastAppliedCodecBitrateBps: Int = 2_400_000
    private var lastBitrateUpdateElapsedMs: Long = 0L

    private var lastRealTimestampNs: Long = Long.MIN_VALUE
    private var lastCodecPtsNs: Long = 0L
    private var consecutiveIdleGaps: Int = 0
    private var vbvRearmActive: Boolean = false
    private var vbvRearmStartElapsedMs: Long = 0L
    private var vbvRearmFramesRemaining: Int = 0
    private var lastKeyframeRequestElapsedMs: Long = 0L

    @Volatile
    private var hasSentAnyKeyframe: Boolean = false

    @Volatile
    private var cachedConfigBytes: ByteArray? = null

    // Telemetry counters (logged every 2s while active)
    private var statWindowStartMs: Long = 0L
    private var statFrameCount: Int = 0
    private var statKeyCount: Int = 0
    private var statTotalBytes: Long = 0L
    private var statMaxKeyBytes: Int = 0
    private var statTotalEncodeUs: Long = 0L
    private val statInFlightDrops = AtomicInteger(0)

    override fun isHardwareEncoder(): Boolean = true

    override fun getImplementationName(): String = "VeloDeckLowLatencyH264($codecName)"

    override fun getScalingSettings(): VideoEncoder.ScalingSettings = VideoEncoder.ScalingSettings.OFF

    override fun getEncoderInfo(): VideoEncoder.EncoderInfo = VideoEncoder.EncoderInfo(2, false)

    /**
     * Signals the encoder to emit an immediate hardware IDR sync frame on the next `encode()` call
     * (used by explicit `request_keyframe` control commands).
     */
    fun requestSyncFrame() {
        forceNextSyncFrame.set(true)
    }

    override fun initEncode(
        settings: VideoEncoder.Settings,
        encodeCallback: VideoEncoder.Callback,
    ): VideoCodecStatus {
        releaseResources()
        callback = encodeCallback
        width = alignEven(settings.width.coerceAtLeast(160))
        height = alignEven(settings.height.coerceAtLeast(160))
        targetFps = settings.maxFramerate.coerceIn(20, 60)
        // WebRTC passes settings.startBitrate in kbps; ensure crisp initial frame on 720p+ streams
        // (use short edge so landscape 1610x720 gets the same floor as portrait 720x1610)
        val rawInitialBps = if (settings.startBitrate > 0) {
            settings.startBitrate * 1_000
        } else {
            4_500_000
        }
        val floorInitialBps = LowLatencyEncoderMath.minBitrateForResolution(width, height)
        currentBitrateBps = LowLatencyEncoderMath.clampBitrateBps(
            requestedBps = rawInitialBps.coerceAtLeast(floorInitialBps),
            minFloorBps = floorInitialBps,
        )
        lastAppliedCodecBitrateBps = currentBitrateBps
        lastBitrateUpdateElapsedMs = SystemClock.elapsedRealtime()
        lastRealTimestampNs = Long.MIN_VALUE
        lastCodecPtsNs = 0L
        consecutiveIdleGaps = 0
        vbvRearmActive = false
        vbvRearmStartElapsedMs = 0L
        vbvRearmFramesRemaining = 0
        lastKeyframeRequestElapsedMs = 0L
        hasSentAnyKeyframe = false
        cachedConfigBytes = null
        synchronized(metaLock) { pendingMeta.clear() }
        statInFlightDrops.set(0)
        resetStatsWindow()

        return initCodecAndSurface()
    }

    private fun initCodecAndSurface(): VideoCodecStatus {
        val egl14Ctx = sharedContext as? EglBase14.Context
        if (egl14Ctx == null) {
            Log.w(TAG, "Shared EglBase context is not EglBase14; falling back")
            return VideoCodecStatus.FALLBACK_SOFTWARE
        }

        val mediaCodec = try {
            MediaCodec.createByCodecName(codecName)
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to create MediaCodec $codecName", t)
            return VideoCodecStatus.FALLBACK_SOFTWARE
        }

        val configured = configureCodecWithFallbacks(mediaCodec)
        if (configured == null) {
            try {
                mediaCodec.release()
            } catch (_: Throwable) {
            }
            return VideoCodecStatus.FALLBACK_SOFTWARE
        }

        var localSurface: Surface? = null
        var localEgl: EglBase14? = null
        return try {
            val surface = mediaCodec.createInputSurface()
            localSurface = surface
            val egl = EglBase.createEgl14(egl14Ctx, EglBase.CONFIG_RECORDABLE)
            localEgl = egl
            egl.createSurface(surface)
            egl.makeCurrent()

            mediaCodec.start()

            codec = mediaCodec
            inputSurface = surface
            encoderEgl = egl
            glRectDrawer = GlRectDrawer()
            videoFrameDrawer = VideoFrameDrawer()
            running = true

            val encWidth = width
            val encHeight = height
            val inputFmt = try {
                mediaCodec.inputFormat.toString()
            } catch (_: Throwable) {
                "n/a"
            }
            Log.i(
                TAG,
                "Initialized $codecName (tier=${configured.tier.label}, profile=${profileLabel(configured)}, " +
                    "${encWidth}x${encHeight}@${targetFps}fps, bitrate=${currentBitrateBps / 1000}kbps, " +
                    "intraRefresh=$supportsIntraRefresh) inputFormat=$inputFmt",
            )

            outputThread = Thread({ drainOutputLoop(mediaCodec, encWidth, encHeight) }, "VeloDeckH264Out").apply {
                isDaemon = true
                start()
            }
            VideoCodecStatus.OK
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to start $codecName surface pipeline", t)
            if (encoderEgl == null && localEgl != null) {
                try {
                    localEgl.releaseSurface()
                    localEgl.detachCurrent()
                    localEgl.release()
                } catch (_: Throwable) {
                }
            }
            if (inputSurface == null && localSurface != null) {
                try {
                    localSurface.release()
                } catch (_: Throwable) {
                }
            }
            if (codec == null) {
                try {
                    mediaCodec.release()
                } catch (_: Throwable) {
                }
            }
            releaseResources()
            VideoCodecStatus.FALLBACK_SOFTWARE
        }
    }

    /**
     * Tiered configuration guarantees full industrial low-latency features on Snapdragon/Dimensity/Exynos
     * flagship chips while safely degrading on older or stricter HALs without ever failing startup.
     *
     * Profile/level fallback (Tier 2b) is split from low-latency fallback (Tier 3) so strict HALs
     * NEVER lose `KEY_LATENCY = 1` (+67ms) just because of a profile or AVC level mismatch.
     */
    private fun configureCodecWithFallbacks(mediaCodec: MediaCodec): ConfiguredCodec? {
        val supportedLevelsByProfile: Map<Int, List<Int>> = try {
            val caps = mediaCodec.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
            caps.profileLevels
                ?.groupBy({ it.profile }, { it.level })
                .orEmpty()
        } catch (_: Throwable) {
            emptyMap()
        }
        val targetProfile = LowLatencyEncoderMath.selectAvcProfile(
            useHighProfile = useHighProfile,
            supportedProfiles = supportedLevelsByProfile.keys,
            sdkInt = Build.VERSION.SDK_INT,
        )
        for (tier in ConfigTier.values()) {
            val format = buildMediaFormat(tier, targetProfile, supportedLevelsByProfile)
            try {
                mediaCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                return ConfiguredCodec(tier, targetProfile)
            } catch (t: Throwable) {
                Log.w(TAG, "MediaCodec configure tier=${tier.label} rejected by $codecName (${t.message}); trying fallback")
                try {
                    mediaCodec.reset()
                } catch (_: Throwable) {
                }
            }
        }
        return null
    }

    private fun buildMediaFormat(
        tier: ConfigTier,
        targetProfile: Int,
        supportedLevelsByProfile: Map<Int, List<Int>>,
    ): MediaFormat {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
        format.setInteger(
            MediaFormat.KEY_COLOR_FORMAT,
            MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
        )
        format.setInteger(MediaFormat.KEY_BIT_RATE, currentBitrateBps)
        format.setInteger(MediaFormat.KEY_FRAME_RATE, targetFps)
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, KEY_FRAME_INTERVAL_SEC)

        if (tier.includeCbrAndCoreLowLatency) {
            format.setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR,
            )
            format.setInteger(MediaFormat.KEY_PRIORITY, 0) // Realtime DSP priority
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                format.setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
            }
        }

        if (tier.includeAggressiveLowLatency) {
            // Override Qualcomm RequestedPipelineDelayTuningHelper hardcoded algo.delay=4 default
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                format.setInteger(MediaFormat.KEY_LATENCY, 1)
            }
            // Keep VPU frequency hot even during concurrent foreground app video playback (e.g., Bilibili)
            format.setInteger(MediaFormat.KEY_OPERATING_RATE, OPERATING_RATE_FPS)
            if (supportsIntraRefresh) {
                format.setInteger(MediaFormat.KEY_INTRA_REFRESH_PERIOD, INTRA_REFRESH_FRAMES)
            }
            if (isQualcommCodec(codecName)) {
                format.setInteger("vendor.qti-ext-enc-low-latency.enable", 1)
            }
        }

        if (tier.includeProfileAndLevel) {
            // Prefer Constrained High (API 27+) -> High -> Constrained Baseline -> Baseline so
            // CABAC + 8x8 DCT text sharpness is preserved without 2-4 frame decoder DPB reorder lag.
            format.setInteger(MediaFormat.KEY_PROFILE, targetProfile)
            val desiredLevel = LowLatencyEncoderMath.selectAvcLevel(width, height, targetFps)
            val resolvedLevel = LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = desiredLevel,
                supportedLevelsForProfile = supportedLevelsByProfile[targetProfile].orEmpty(),
            )
            if (resolvedLevel != null) {
                format.setInteger(MediaFormat.KEY_LEVEL, resolvedLevel)
            }
        }

        if (tier.includeQpBounds && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Bounded Android 12+ QP window [20..42/46] prevents QP-12 VBV explosions on idle->motion
            // while giving hardware CBR enough headroom to avoid QP-38 FrameDropper spirals.
            format.setInteger(MediaFormat.KEY_VIDEO_QP_I_MIN, QP_MIN)
            format.setInteger(MediaFormat.KEY_VIDEO_QP_I_MAX, QP_I_MAX)
            format.setInteger(MediaFormat.KEY_VIDEO_QP_P_MIN, QP_MIN)
            format.setInteger(MediaFormat.KEY_VIDEO_QP_P_MAX, QP_P_MAX)
        }

        return format
    }

    private fun profileLabel(configured: ConfiguredCodec): String {
        if (!configured.tier.includeProfileAndLevel) return "Auto"
        return when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 &&
                configured.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh -> "ConstrainedHigh"
            configured.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh -> "High"
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1 &&
                configured.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline -> "ConstrainedBaseline"
            configured.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline -> "Baseline"
            else -> "Profile(${configured.profile})"
        }
    }

    override fun encode(
        frame: VideoFrame,
        encodeInfo: VideoEncoder.EncodeInfo,
    ): VideoCodecStatus {
        val activeCodec = codec
        val egl = encoderEgl
        val drawer = glRectDrawer
        val frameDrawer = videoFrameDrawer
        if (!running || activeCodec == null || egl == null || drawer == null || frameDrawer == null) {
            return VideoCodecStatus.UNINITIALIZED
        }

        // Handle dynamic display orientation/resolution change seamlessly
        val frameW = alignEven(frame.buffer.width.coerceAtLeast(160))
        val frameH = alignEven(frame.buffer.height.coerceAtLeast(160))
        if (frameW != width || frameH != height) {
            Log.i(TAG, "Frame dimensions changed ${width}x${height} -> ${frameW}x${frameH}; reinitializing $codecName")
            val savedCallback = callback ?: return VideoCodecStatus.UNINITIALIZED
            val savedBitrateKbps = currentBitrateBps / 1000
            val reinitStatus = initEncode(
                VideoEncoder.Settings(
                    1,
                    frameW,
                    frameH,
                    savedBitrateKbps,
                    targetFps,
                    1,
                    false,
                    VideoEncoder.Capabilities(false),
                ),
                savedCallback,
            )
            if (reinitStatus != VideoCodecStatus.OK) {
                return reinitStatus
            }
        }

        val currentCodec = codec ?: return VideoCodecStatus.UNINITIALIZED
        val currentEgl = encoderEgl ?: return VideoCodecStatus.UNINITIALIZED
        val currentDrawer = glRectDrawer ?: return VideoCodecStatus.UNINITIALIZED
        val currentFrameDrawer = videoFrameDrawer ?: return VideoCodecStatus.UNINITIALIZED

        // Single source of truth for in-flight depth: prune stale (>500ms) entries first so VPU
        // frame drops before static idle self-heal automatically instead of permanently freezing.
        val submitElapsedNs = SystemClock.elapsedRealtimeNanos()
        val inFlightFull = synchronized(metaLock) {
            while (pendingMeta.isNotEmpty() &&
                submitElapsedNs - pendingMeta.first().submitElapsedNs > STALE_IN_FLIGHT_NS
            ) {
                pendingMeta.removeFirst()
            }
            pendingMeta.size >= MAX_IN_FLIGHT_FRAMES
        }
        if (inFlightFull) {
            statInFlightDrops.incrementAndGet()
            return VideoCodecStatus.NO_OUTPUT
        }

        // Trigger hardware IDR when explicitly requested via requestSyncFrame() OR rate-limited WebRTC PLI
        val forcedKey = forceNextSyncFrame.getAndSet(false)
        val wantsKeyFrame = encodeInfo.frameTypes.any { it == EncodedImage.FrameType.VideoFrameKey }
        val nowMs = SystemClock.elapsedRealtime()
        if (forcedKey || LowLatencyEncoderMath.shouldAllowKeyframeRequest(
                explicitRequested = wantsKeyFrame,
                elapsedSinceLastKeyMs = nowMs - lastKeyframeRequestElapsedMs,
                hasSentAnyKeyframe = hasSentAnyKeyframe,
            )
        ) {
            try {
                val params = Bundle().apply {
                    putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0)
                }
                currentCodec.setParameters(params)
                lastKeyframeRequestElapsedMs = nowMs
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to request sync frame", t)
            }
        }

        // Compute strictly clamped monotonic codec PTS (eliminates idle-gap CBR & VBV-credit spikes!)
        val hadPreviousFrame = lastRealTimestampNs != Long.MIN_VALUE
        val rawDeltaNs = if (hadPreviousFrame) frame.timestampNs - lastRealTimestampNs else 0L
        val wasIdle = consecutiveIdleGaps > 0
        val isIdleGap = hadPreviousFrame && rawDeltaNs >= LowLatencyEncoderMath.STATIC_SETTLE_RAW_DELTA_NS

        val codecPtsNs = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = lastRealTimestampNs,
            currentRealTsNs = frame.timestampNs,
            previousCodecPtsNs = lastCodecPtsNs,
            targetFps = targetFps,
            consecutiveIdleGaps = consecutiveIdleGaps,
        )
        if (isIdleGap) {
            consecutiveIdleGaps = (consecutiveIdleGaps + 1).coerceAtMost(1_000)
        } else {
            consecutiveIdleGaps = 0
        }
        lastRealTimestampNs = frame.timestampNs
        lastCodecPtsNs = codecPtsNs
        val codecPtsUs = codecPtsNs / 1_000L

        // VBV re-arm on idle->motion resume: briefly nudge bitrate to 75% on the first frame after
        // an idle gap so c2.qti.avc.encoder re-clamps its empty leaky bucket instead of dumping a
        // 150 KB surplus burst, then smoothly restore 100% after ~250ms / 10 frames.
        val shouldRearmVbv = hadPreviousFrame && wasIdle && (
            rawDeltaNs >= LowLatencyEncoderMath.IDLE_RESUME_RAW_DELTA_NS ||
                (!isIdleGap && !vbvRearmActive)
            )
        if (shouldRearmVbv) {
            val nudgedBps = LowLatencyEncoderMath.computeVbvRearmBitrateBps(
                currentBitrateBps = currentBitrateBps,
                lastAppliedCodecBitrateBps = lastAppliedCodecBitrateBps,
            )
            try {
                val params = Bundle().apply {
                    putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, nudgedBps)
                }
                currentCodec.setParameters(params)
                lastAppliedCodecBitrateBps = nudgedBps
                vbvRearmActive = true
                vbvRearmStartElapsedMs = nowMs
                vbvRearmFramesRemaining = LowLatencyEncoderMath.VBV_REARM_RESTORE_FRAMES
            } catch (t: Throwable) {
                Log.w(TAG, "Failed to re-arm VBV bitrate on idle resume", t)
            }
        } else if (vbvRearmActive) {
            vbvRearmFramesRemaining--
            if (vbvRearmFramesRemaining <= 0 ||
                (nowMs - vbvRearmStartElapsedMs) >= LowLatencyEncoderMath.VBV_REARM_RESTORE_MS
            ) {
                val restoreBps = currentBitrateBps
                try {
                    val params = Bundle().apply {
                        putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, restoreBps)
                    }
                    currentCodec.setParameters(params)
                    lastAppliedCodecBitrateBps = restoreBps
                    vbvRearmActive = false
                } catch (t: Throwable) {
                    Log.w(TAG, "Failed to restore bitrate after VBV re-arm", t)
                }
            }
        }

        val meta = FrameMeta(
            codecPtsUs = codecPtsUs,
            captureTimeNs = frame.timestampNs,
            rotation = frame.rotation,
            submitElapsedNs = submitElapsedNs,
        )
        synchronized(metaLock) {
            pendingMeta.addLast(meta)
            while (pendingMeta.size > MAX_PENDING_META) {
                pendingMeta.removeFirst()
            }
        }

        return try {
            currentEgl.makeCurrent()
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            val drawFrame = if (frame.rotation == 0) {
                frame
            } else {
                VideoFrame(frame.buffer, 0, frame.timestampNs)
            }
            currentFrameDrawer.drawFrame(drawFrame, currentDrawer, null, 0, 0, width, height)
            currentEgl.swapBuffers(codecPtsNs)
            VideoCodecStatus.OK
        } catch (t: Throwable) {
            Log.e(TAG, "GL texture draw/swap failed during encode", t)
            synchronized(metaLock) {
                if (pendingMeta.isNotEmpty() && pendingMeta.last() === meta) {
                    pendingMeta.removeLast()
                }
            }
            VideoCodecStatus.ERROR
        }
    }

    override fun setRates(rcParameters: VideoEncoder.RateControlParameters): VideoCodecStatus {
        val rawFps = ceil(rcParameters.framerateFps).toInt()
        val fps = if (rawFps >= 20) rawFps.coerceIn(20, 60) else rawFps
        return setRateAllocation(rcParameters.bitrate, fps)
    }

    override fun setRateAllocation(
        allocation: VideoEncoder.BitrateAllocation,
        framerate: Int,
    ): VideoCodecStatus {
        val activeCodec = codec ?: return VideoCodecStatus.OK
        if (!running) return VideoCodecStatus.OK

        // Track live target FPS (Auto 20..60fps, ECO 30fps, BALANCED/HD 60fps) so PTS clamping & reinit match
        if (framerate >= 20) {
            targetFps = framerate.coerceIn(20, 60)
        }

        val requestedBps = allocation.sum
        if (requestedBps <= 0) return VideoCodecStatus.OK
        val resFloorBps = LowLatencyEncoderMath.minBitrateForResolution(width, height)
        val clampedBps = LowLatencyEncoderMath.clampBitrateBps(requestedBps, minFloorBps = resFloorBps)
        val nowMs = SystemClock.elapsedRealtime()
        if (!LowLatencyEncoderMath.shouldApplyBitrateUpdate(
                currentBps = currentBitrateBps,
                targetBps = clampedBps,
                elapsedSinceLastUpdateMs = nowMs - lastBitrateUpdateElapsedMs,
            )
        ) {
            return VideoCodecStatus.OK
        }

        val codecBps = if (vbvRearmActive) {
            LowLatencyEncoderMath.computeVbvRearmBitrateBps(clampedBps)
        } else {
            clampedBps
        }
        return try {
            val params = Bundle().apply {
                putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, codecBps)
            }
            activeCodec.setParameters(params)
            currentBitrateBps = clampedBps
            lastAppliedCodecBitrateBps = codecBps
            lastBitrateUpdateElapsedMs = nowMs
            VideoCodecStatus.OK
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to update dynamic bitrate to ${clampedBps / 1000}kbps", t)
            VideoCodecStatus.OK
        }
    }

    override fun release(): VideoCodecStatus {
        releaseResources()
        onReleased?.invoke(this)
        return VideoCodecStatus.OK
    }

    private fun releaseResources() {
        running = false

        // 1. Join output drain thread first so no dequeue/drain runs during teardown
        val thread = outputThread
        outputThread = null
        if (thread != null) {
            try {
                thread.join(500L)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }

        // 2. Make EGL current -> release GL drawers -> release EGL surface/context
        val egl = encoderEgl
        encoderEgl = null
        try {
            egl?.makeCurrent()
        } catch (_: Throwable) {
        }

        try {
            videoFrameDrawer?.release()
        } catch (_: Throwable) {
        }
        videoFrameDrawer = null

        try {
            glRectDrawer?.release()
        } catch (_: Throwable) {
        }
        glRectDrawer = null

        try {
            egl?.releaseSurface()
            egl?.detachCurrent()
            egl?.release()
        } catch (_: Throwable) {
        }

        // 3. Release input Surface before stopping/releasing MediaCodec
        try {
            inputSurface?.release()
        } catch (_: Throwable) {
        }
        inputSurface = null

        // 4. Stop and release MediaCodec last
        val activeCodec = codec
        codec = null
        if (activeCodec != null) {
            try {
                activeCodec.stop()
            } catch (_: Throwable) {
            }
            try {
                activeCodec.release()
            } catch (_: Throwable) {
            }
        }

        synchronized(metaLock) { pendingMeta.clear() }
        forceNextSyncFrame.set(false)
        consecutiveIdleGaps = 0
        vbvRearmActive = false
        vbvRearmStartElapsedMs = 0L
        vbvRearmFramesRemaining = 0
        cachedConfigBytes = null
        directBufferPool.clear()
    }

    private fun drainOutputLoop(mediaCodec: MediaCodec, encWidth: Int, encHeight: Int) {
        try {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
        } catch (_: Throwable) {
        }

        val bufferInfo = MediaCodec.BufferInfo()
        val headerScratch = ByteArray(LowLatencyEncoderMath.SPS_SCAN_LIMIT_BYTES)
        while (running) {
            val outIndex = try {
                mediaCodec.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
            } catch (t: Throwable) {
                if (running) {
                    Log.w(TAG, "dequeueOutputBuffer failed: ${t.message}")
                }
                break
            }

            if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                continue
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val outFmt = try {
                    mediaCodec.outputFormat.toString()
                } catch (_: Throwable) {
                    "n/a"
                }
                Log.i(TAG, "$codecName outputFormat=$outFmt")
                continue
            } else if (outIndex < 0) {
                continue
            }

            var outputReleased = false
            var unhandedPooledBuf: ByteBuffer? = null
            try {
                val outBuf = mediaCodec.getOutputBuffer(outIndex)
                if (outBuf != null && bufferInfo.size > 0) {
                    val size = bufferInfo.size
                    val offset = bufferInfo.offset
                    val isConfig = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    if (isConfig) {
                        outBuf.position(offset)
                        outBuf.limit(offset + size)
                        val configBytes = ByteArray(size)
                        outBuf.get(configBytes)
                        mediaCodec.releaseOutputBuffer(outIndex, false)
                        outputReleased = true
                        cachedConfigBytes = configBytes
                        Log.i(TAG, "Cached H.264 SPS/PPS config (${configBytes.size} bytes)")
                        continue
                    }

                    val isKeyFrame = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                    val config = if (isKeyFrame) cachedConfigBytes else null
                    var needPrependConfig = false
                    if (isKeyFrame && config != null && config.isNotEmpty()) {
                        val peekLen = size.coerceAtMost(headerScratch.size)
                        outBuf.position(offset)
                        outBuf.limit(offset + peekLen)
                        outBuf.get(headerScratch, 0, peekLen)
                        needPrependConfig = !LowLatencyEncoderMath.startsWithSpsNal(headerScratch, peekLen)
                    }

                    val prependLen = if (needPrependConfig && config != null) config.size else 0
                    val totalSize = prependLen + size

                    val pooledBuf: ByteBuffer?
                    val backingBuf: ByteBuffer
                    if (totalSize <= POOLED_BUFFER_CAPACITY) {
                        val reused = directBufferPool.poll()
                        backingBuf = reused ?: ByteBuffer.allocateDirect(POOLED_BUFFER_CAPACITY)
                        backingBuf.clear()
                        pooledBuf = backingBuf
                        unhandedPooledBuf = backingBuf
                    } else {
                        backingBuf = ByteBuffer.allocateDirect(totalSize)
                        pooledBuf = null
                    }

                    if (prependLen > 0 && config != null) {
                        backingBuf.put(config)
                    }
                    outBuf.position(offset)
                    outBuf.limit(offset + size)
                    backingBuf.put(outBuf)
                    backingBuf.flip()
                    val payloadSlice = backingBuf.slice()

                    // Release MediaCodec output buffer IMMEDIATELY so VPU pool is never starved!
                    mediaCodec.releaseOutputBuffer(outIndex, false)
                    outputReleased = true

                    // Ownership of pooledBuf transfers to deliverEncodedBuffer
                    unhandedPooledBuf = null
                    deliverEncodedBuffer(
                        payloadSlice = payloadSlice,
                        pooledBackingBuf = pooledBuf,
                        totalSize = totalSize,
                        bufferInfo = bufferInfo,
                        isKeyFrame = isKeyFrame,
                        encWidth = encWidth,
                        encHeight = encHeight,
                    )
                } else {
                    mediaCodec.releaseOutputBuffer(outIndex, false)
                    outputReleased = true
                }
            } catch (t: Throwable) {
                if (unhandedPooledBuf != null) {
                    returnDirectBuffer(unhandedPooledBuf)
                }
                if (running) {
                    Log.w(TAG, "Output drain error: ${t.message}")
                }
                if (!outputReleased) {
                    try {
                        mediaCodec.releaseOutputBuffer(outIndex, false)
                    } catch (_: Throwable) {
                    }
                }
            }
        }
    }

    private fun deliverEncodedBuffer(
        payloadSlice: ByteBuffer,
        pooledBackingBuf: ByteBuffer?,
        totalSize: Int,
        bufferInfo: MediaCodec.BufferInfo,
        isKeyFrame: Boolean,
        encWidth: Int,
        encHeight: Int,
    ) {
        val cb = callback
        if (cb == null) {
            if (pooledBackingBuf != null) returnDirectBuffer(pooledBackingBuf)
            return
        }

        val meta = popMatchingMeta(bufferInfo.presentationTimeUs)
        if (isKeyFrame) {
            hasSentAnyKeyframe = true
        }

        val captureTimeNs = meta?.captureTimeNs ?: System.nanoTime()
        val rotation = meta?.rotation ?: 0
        val encodeLatencyUs = if (meta != null) {
            ((SystemClock.elapsedRealtimeNanos() - meta.submitElapsedNs) / 1_000L).coerceAtLeast(0L)
        } else {
            0L
        }

        val frameType = if (isKeyFrame) {
            EncodedImage.FrameType.VideoFrameKey
        } else {
            EncodedImage.FrameType.VideoFrameDelta
        }

        val releaseCallback = if (pooledBackingBuf != null) {
            Runnable { returnDirectBuffer(pooledBackingBuf) }
        } else {
            null
        }

        val encodedImage = EncodedImage.builder()
            .setBuffer(payloadSlice, releaseCallback)
            .setEncodedWidth(encWidth)
            .setEncodedHeight(encHeight)
            .setCaptureTimeNs(captureTimeNs)
            .setFrameType(frameType)
            .setRotation(rotation)
            .createEncodedImage()

        try {
            cb.onEncodedFrame(encodedImage, VideoEncoder.CodecSpecificInfo())
        } finally {
            encodedImage.release()
        }

        recordTelemetry(totalSize, isKeyFrame, encodeLatencyUs, encWidth, encHeight)
    }

    private fun returnDirectBuffer(buf: ByteBuffer) {
        buf.clear()
        if (running) {
            directBufferPool.offer(buf)
        }
    }

    private fun popMatchingMeta(codecPtsUs: Long): FrameMeta? {
        synchronized(metaLock) {
            if (pendingMeta.isEmpty()) return null
            while (pendingMeta.size > 1 && pendingMeta.first().codecPtsUs < codecPtsUs - 1_000L) {
                pendingMeta.removeFirst()
            }
            return pendingMeta.removeFirst()
        }
    }

    private fun resetStatsWindow() {
        statWindowStartMs = SystemClock.elapsedRealtime()
        statFrameCount = 0
        statKeyCount = 0
        statTotalBytes = 0L
        statMaxKeyBytes = 0
        statTotalEncodeUs = 0L
    }

    private fun recordTelemetry(
        frameBytes: Int,
        isKeyFrame: Boolean,
        encodeLatencyUs: Long,
        encWidth: Int,
        encHeight: Int,
    ) {
        statFrameCount++
        statTotalBytes += frameBytes
        statTotalEncodeUs += encodeLatencyUs
        if (isKeyFrame) {
            statKeyCount++
            if (frameBytes > statMaxKeyBytes) statMaxKeyBytes = frameBytes
            Log.i(
                TAG,
                "IDR keyframe emitted: size=${frameBytes}B (${frameBytes / 1024}KB), " +
                    "encodeMs=${"%.1f".format(encodeLatencyUs / 1000.0)}, target=${currentBitrateBps / 1000}kbps",
            )
        }

        val nowMs = SystemClock.elapsedRealtime()
        val elapsedMs = nowMs - statWindowStartMs
        if (elapsedMs >= STATS_LOG_INTERVAL_MS) {
            val fps = (statFrameCount * 1000.0) / elapsedMs.coerceAtLeast(1L)
            val actualKbps = (statTotalBytes * 8.0) / elapsedMs.coerceAtLeast(1L)
            val avgEncodeMs = if (statFrameCount > 0) {
                (statTotalEncodeUs.toDouble() / statFrameCount) / 1000.0
            } else {
                0.0
            }
            val avgFrameKb = if (statFrameCount > 0) {
                (statTotalBytes.toDouble() / statFrameCount) / 1024.0
            } else {
                0.0
            }
            val drops = statInFlightDrops.getAndSet(0)
            Log.i(
                TAG,
                "EncoderStats(${encWidth}x${encHeight}): fps=${"%.1f".format(fps)}, " +
                    "bitrate=${"%.0f".format(actualKbps)}/${currentBitrateBps / 1000}kbps, " +
                    "avgEncode=${"%.1f".format(avgEncodeMs)}ms, avgFrame=${"%.1f".format(avgFrameKb)}KB, " +
                    "keys=$statKeyCount(max=${statMaxKeyBytes / 1024}KB), drops=$drops",
            )
            resetStatsWindow()
        }
    }

    private fun alignEven(value: Int): Int = (value / 2) * 2

    private fun isQualcommCodec(name: String): Boolean {
        val lower = name.lowercase()
        return lower.startsWith("c2.qti.") || lower.startsWith("omx.qcom.")
    }

    companion object {
        private const val TAG = "LowLatencyH264Encoder"
        private const val DEQUEUE_TIMEOUT_US = 10_000L
        private const val KEY_FRAME_INTERVAL_SEC = 60
        private const val OPERATING_RATE_FPS = LowLatencyEncoderMath.OPERATING_RATE_FPS
        private const val INTRA_REFRESH_FRAMES = 120
        private const val MAX_IN_FLIGHT_FRAMES = LowLatencyEncoderMath.MAX_IN_FLIGHT_FRAMES
        private const val MAX_PENDING_META = 24
        private const val STALE_IN_FLIGHT_NS = 500_000_000L
        private const val BUFFER_POOL_SIZE = 8
        private const val POOLED_BUFFER_CAPACITY = 196_608 // 192 KB (comfortably fits 1080p High IDR frames)
        private const val STATS_LOG_INTERVAL_MS = 2_000L
        private const val QP_MIN = LowLatencyEncoderMath.QP_MIN
        private const val QP_I_MAX = LowLatencyEncoderMath.QP_I_MAX
        private const val QP_P_MAX = LowLatencyEncoderMath.QP_P_MAX
    }
}
