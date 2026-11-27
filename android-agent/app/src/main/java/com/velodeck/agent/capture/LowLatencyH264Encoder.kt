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
     * Scales the maximum motion codec PTS step to match the active encoder frame rate (`24..60 fps`)
     * so 30fps ECO streams receive `33.33ms` nominal budget instead of `16.67ms` PTS starvation.
     */
    fun maxFrameDeltaNsForFps(targetFps: Int): Long =
        1_000_000_000L / targetFps.coerceIn(24, 60)

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
     * Brisk initial bitrate (`55%` of preset max, clamped to `[1200, 4000] kbps`) for SDP
     * `x-google-start-bitrate` so LAN starts crisp immediately while WAN/TURN can adapt downward.
     */
    fun computeSdpStartBitrateKbps(presetMaxKbps: Int): Int =
        ((presetMaxKbps * 55) / 100).coerceIn(1_200, 4_000)

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
        targetFps = settings.maxFramerate.coerceIn(24, 60)
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
        val fps = if (rawFps >= 24) rawFps.coerceIn(24, 60) else rawFps
        return setRateAllocation(rcParameters.bitrate, fps)
    }

    override fun setRateAllocation(
        allocation: VideoEncoder.BitrateAllocation,
        framerate: Int,
    ): VideoCodecStatus {
        val activeCodec = codec ?: return VideoCodecStatus.OK
        if (!running) return VideoCodecStatus.OK

        // Track live target FPS (ECO 30fps <-> BALANCED/HD 60fps) so PTS clamping & reinit match
        if (framerate >= 24) {
            targetFps = framerate.coerceIn(24, 60)
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
