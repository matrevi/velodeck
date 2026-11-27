package com.velodeck.agent

import android.media.MediaCodecInfo
import com.velodeck.agent.capture.DisplayScaleMath
import com.velodeck.agent.capture.LowLatencyEncoderMath
import com.velodeck.agent.capture.LowLatencyH264EncoderFactory
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LowLatencyEncoderLogicTest {

    @Test
    fun `nextClampedCodecPtsNs clamps motion to 16_67ms and grants 24ms static-settle refinement`() {
        assertEquals(16_666_667L, LowLatencyEncoderMath.MAX_FRAME_DELTA_NS)
        assertEquals(24_000_000L, LowLatencyEncoderMath.STATIC_SETTLE_DELTA_NS)

        val pts0 = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = Long.MIN_VALUE,
            currentRealTsNs = 1_000_000_000L,
            previousCodecPtsNs = 0L,
        )
        assertEquals(LowLatencyEncoderMath.DEFAULT_FRAME_DELTA_NS, pts0)

        // Simulate 2.5-second idle screen gap -> bounded 24ms refinement step (still prevents CBR monster IDR!)
        val ptsAfterIdle = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 1_000_000_000L,
            currentRealTsNs = 3_500_000_000L,
            previousCodecPtsNs = pts0,
        )
        assertEquals(pts0 + 24_000_000L, ptsAfterIdle)

        // Active 60fps scrolling (~16.67ms delta) passes through untouched
        val ptsScrolling = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 3_500_000_000L,
            currentRealTsNs = 3_516_666_667L,
            previousCodecPtsNs = ptsAfterIdle,
        )
        assertEquals(ptsAfterIdle + 16_666_667L, ptsScrolling)

        // 30fps motion (33ms < 180ms settle threshold) clamps to 16.67ms
        val pts30fps = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 3_516_666_667L,
            currentRealTsNs = 3_550_000_000L,
            previousCodecPtsNs = ptsScrolling,
        )
        assertEquals(ptsScrolling + 16_666_667L, pts30fps)

        // Duplicate / backwards timestamp clamps cleanly to MIN_FRAME_DELTA_NS (8ms)
        val ptsDup = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 3_550_000_000L,
            currentRealTsNs = 3_550_000_000L,
            previousCodecPtsNs = pts30fps,
        )
        assertEquals(pts30fps + LowLatencyEncoderMath.MIN_FRAME_DELTA_NS, ptsDup)
    }

    @Test
    fun `startsWithSpsNal detects 4-byte, 3-byte, and post-AUD-SEI SPS headers up to 512 bytes`() {
        val sps4 = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1F)
        val sps3 = byteArrayOf(0x00, 0x00, 0x01, 0x27, 0x42, 0x00, 0x1F)
        val idrOnly = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x65, 0x88.toByte(), 0x84.toByte())
        val pFrame = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x41, 0x9A.toByte())

        assertTrue(LowLatencyEncoderMath.startsWithSpsNal(sps4))
        assertTrue(LowLatencyEncoderMath.startsWithSpsNal(sps3))
        assertFalse(LowLatencyEncoderMath.startsWithSpsNal(idrOnly))
        assertFalse(LowLatencyEncoderMath.startsWithSpsNal(pFrame))

        // AUD + 120-byte SEI prefix (> 64 bytes old cap) followed by SPS -> must detect SPS
        val audPrefix = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x09, 0xF0.toByte())
        val seiPrefix = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x06) + ByteArray(120) { 0x55 }
        val audSeiSpsIdr = audPrefix + seiPrefix + sps4 + idrOnly
        val audSeiIdrWithoutSps = audPrefix + seiPrefix + idrOnly

        assertTrue(LowLatencyEncoderMath.startsWithSpsNal(audSeiSpsIdr))
        assertFalse(LowLatencyEncoderMath.startsWithSpsNal(audSeiIdrWithoutSps))
    }

    @Test
    fun `buildOutputBytesWithConfigIfNeeded prepends SPS PPS only when missing on keyframes`() {
        val config = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x00, 0x00, 0x01, 0x68)
        val idrWithoutConfig = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x65, 0x11, 0x22)
        val idrWithConfig = config + idrWithoutConfig
        val deltaFrame = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x41, 0x33)

        assertArrayEquals(
            idrWithConfig,
            LowLatencyEncoderMath.buildOutputBytesWithConfigIfNeeded(idrWithoutConfig, true, config),
        )
        // Must not duplicate SPS/PPS if encoder already prepended it
        assertArrayEquals(
            idrWithConfig,
            LowLatencyEncoderMath.buildOutputBytesWithConfigIfNeeded(idrWithConfig, true, config),
        )
        // Delta frames must never get SPS/PPS prepended
        assertArrayEquals(
            deltaFrame,
            LowLatencyEncoderMath.buildOutputBytesWithConfigIfNeeded(deltaFrame, false, config),
        )
    }

    @Test
    fun `PLI keyframe rate limiter allows first keyframe immediately and throttles storms`() {
        assertTrue(
            LowLatencyEncoderMath.shouldAllowKeyframeRequest(
                explicitRequested = true,
                elapsedSinceLastKeyMs = 0L,
                hasSentAnyKeyframe = false,
            ),
        )
        assertFalse(
            LowLatencyEncoderMath.shouldAllowKeyframeRequest(
                explicitRequested = true,
                elapsedSinceLastKeyMs = 120L,
                hasSentAnyKeyframe = true,
            ),
        )
        assertTrue(
            LowLatencyEncoderMath.shouldAllowKeyframeRequest(
                explicitRequested = true,
                elapsedSinceLastKeyMs = 400L,
                hasSentAnyKeyframe = true,
            ),
        )
    }

    @Test
    fun `bitrate clamping, WAN-TURN floors, QP bounds, and tightened 150ms 3-percent threshold guard behave correctly`() {
        assertEquals(150L, LowLatencyEncoderMath.BITRATE_UPDATE_MIN_INTERVAL_MS)
        assertEquals(0.03, LowLatencyEncoderMath.BITRATE_CHANGE_THRESHOLD_RATIO, 1e-9)
        assertEquals(400_000, LowLatencyEncoderMath.MIN_BITRATE_BPS)
        assertEquals(LowLatencyEncoderMath.MIN_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(100_000))
        assertEquals(LowLatencyEncoderMath.MAX_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(25_000_000))

        // WAN/TURN-friendly per-resolution floors
        assertEquals(400_000, LowLatencyEncoderMath.minBitrateForResolution(540, 1206))
        assertEquals(700_000, LowLatencyEncoderMath.minBitrateForResolution(720, 1610))
        assertEquals(900_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012))
        assertEquals(1_200_000, LowLatencyEncoderMath.minBitrateForResolution(2414, 1080))
        assertEquals(
            700_000,
            LowLatencyEncoderMath.clampBitrateBps(500_000, LowLatencyEncoderMath.minBitrateForResolution(720, 1610)),
        )
        assertEquals(
            900_000,
            LowLatencyEncoderMath.clampBitrateBps(600_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012)),
        )
        assertEquals(
            1_200_000,
            LowLatencyEncoderMath.clampBitrateBps(800_000, LowLatencyEncoderMath.minBitrateForResolution(1080, 2414)),
        )

        // Relaxed Android 12+ QP caps prevent CBR FrameDropper stalls during full-screen motion
        assertEquals(12, LowLatencyEncoderMath.QP_MIN)
        assertEquals(34, LowLatencyEncoderMath.QP_I_MAX)
        assertEquals(38, LowLatencyEncoderMath.QP_P_MAX)

        // Adaptive SDP/sender min (20% clamped 500..1500 kbps) and start (55% clamped 1200..4000 kbps)
        assertEquals(500, LowLatencyEncoderMath.computeSdpMinBitrateKbps(1_600))   // ECO
        assertEquals(900, LowLatencyEncoderMath.computeSdpMinBitrateKbps(4_500))   // BALANCED
        assertEquals(1_500, LowLatencyEncoderMath.computeSdpMinBitrateKbps(7_500)) // HD
        assertEquals(1_200, LowLatencyEncoderMath.computeSdpStartBitrateKbps(1_600))
        assertEquals(2_475, LowLatencyEncoderMath.computeSdpStartBitrateKbps(4_500))
        assertEquals(4_000, LowLatencyEncoderMath.computeSdpStartBitrateKbps(7_500))

        // 2.5% delta < 3% threshold -> ignored even after 500ms
        assertFalse(LowLatencyEncoderMath.shouldApplyBitrateUpdate(2_000_000, 2_050_000, 500L))
        // Large delta within 150ms cooldown -> ignored
        assertFalse(LowLatencyEncoderMath.shouldApplyBitrateUpdate(2_000_000, 2_500_000, 100L))
        // 3.5% delta at 160ms (>= 150ms, >= 3%) -> applied for fast BWE recovery
        assertTrue(LowLatencyEncoderMath.shouldApplyBitrateUpdate(2_000_000, 2_070_000, 160L))
        // Large delta after cooldown -> applied
        assertTrue(LowLatencyEncoderMath.shouldApplyBitrateUpdate(2_000_000, 2_500_000, 300L))
    }

    @Test
    fun `normalizeCaptureTimestampNs preserves 120Hz real frame cadence without +16_67ms inflation`() {
        val frameStep120HzNs = 8_333_333L
        var lastRaw = 0L
        var lastDelivered = 0L
        val baseMonotonicNs = 120_000_000_000L // 120s CLOCK_MONOTONIC

        val delivered = mutableListOf<Long>()
        for (i in 0 until 10) {
            val rawTs = baseMonotonicNs + i * frameStep120HzNs
            val nowNs = rawTs + 400_000L // 0.4ms dispatch latency in same CLOCK_MONOTONIC domain
            val ts = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
                rawTsNs = rawTs,
                nowNs = nowNs,
                lastRawSurfaceTsNs = lastRaw,
                lastDeliveredTsNs = lastDelivered,
            )
            assertEquals("Real 120Hz frame #$i must be delivered unchanged", rawTs, ts)
            lastRaw = rawTs
            lastDelivered = ts
            delivered.add(ts)
        }
        // Verify consecutive deltas remain exact 8.333ms so libwebrtc VideoAdapter cleanly decimates 120->60fps
        for (i in 1 until delivered.size) {
            assertEquals(frameStep120HzNs, delivered[i] - delivered[i - 1])
        }
    }

    @Test
    fun `normalizeCaptureTimestampNs aligns monotonically after device sleep and jitter`() {
        // After hours of deep sleep, CLOCK_MONOTONIC (System.nanoTime & SurfaceTexture) is e.g. 500s
        // (far below CLOCK_BOOTTIME, which is no longer used).
        val postSleepMonotonicNs = 500_000_000_000L
        var lastRaw = 0L
        var lastDelivered = 0L

        // 1. Initial forceFrame() fires before first real draw (rawTsNs = 0)
        val tsForce0 = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = 0L,
            nowNs = postSleepMonotonicNs,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(postSleepMonotonicNs, tsForce0)
        lastDelivered = tsForce0

        // 2. Real frame was latched 1.5ms BEFORE forceFrame() ran -> rawTsNs < lastDelivered
        val slightlyOlderRealTs = postSleepMonotonicNs - 1_500_000L
        val nowForOlderReal = postSleepMonotonicNs + 200_000L
        val tsClampedReal = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = slightlyOlderRealTs,
            nowNs = nowForOlderReal,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        // Must clamp by +1ms (NOT +16.67ms!)
        assertEquals(postSleepMonotonicNs + 1_000_000L, tsClampedReal)
        lastRaw = slightlyOlderRealTs
        lastDelivered = tsClampedReal

        // 3. Very next 120Hz real frame (8.333ms later) immediately exceeds lastDelivered and delivers rawTsNs untouched
        val nextRealTs = slightlyOlderRealTs + 8_333_333L
        val tsRecovered = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = nextRealTs,
            nowNs = nextRealTs + 300_000L,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(nextRealTs, tsRecovered)
    }

    @Test
    fun `normalizeCaptureTimestampNs keeps repeated forceFrame monotonic and anchored with zero runaway`() {
        val realFrameTs = 200_000_000_000L
        var lastRaw = realFrameTs
        var lastDelivered = realFrameTs

        // Static screen: forceFrame() repeats lastRawSurfaceTsNs at 250ms and 750ms later
        val force1 = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = realFrameTs,
            nowNs = realFrameTs + 250_000_000L,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(realFrameTs + 250_000_000L, force1)
        lastDelivered = force1

        // Back-to-back forceFrame() only 0.2ms later -> strictly monotonic (+1ms)
        val forceBurst = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = realFrameTs,
            nowNs = force1 + 200_000L,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(force1 + 1_000_000L, forceBurst)
        lastDelivered = forceBurst

        // Next periodic pump 500ms later re-anchors directly to real nowNs (zero drift/runaway)
        val pumpLaterNow = realFrameTs + 750_000_000L
        val force2 = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = realFrameTs,
            nowNs = pumpLaterNow,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(pumpLaterNow, force2)
        lastDelivered = force2

        // Resuming real VirtualDisplay frames right after static pump passes rawTsNs through cleanly
        val resumedRealTs = pumpLaterNow + 8_333_333L
        val resumed = LowLatencyEncoderMath.normalizeCaptureTimestampNs(
            rawTsNs = resumedRealTs,
            nowNs = resumedRealTs + 250_000L,
            lastRawSurfaceTsNs = lastRaw,
            lastDeliveredTsNs = lastDelivered,
        )
        assertEquals(resumedRealTs, resumed)
    }

    @Test
    fun `selectAvcLevel and resolveSupportedAvcLevel pick Level 5_1 for 20-9 HD and Balanced`() {
        // 720p (1280x720 = 3,600 MBs, *120 = 432,000 <= 522,240) and ECO 540x1206 fit Level 4.2
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel42,
            LowLatencyEncoderMath.selectAvcLevel(1280, 720, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel42,
            LowLatencyEncoderMath.selectAvcLevel(540, 1206, 30),
        )

        // 900x2012 (7,182 MBs, *120 = 861,840 > Level 4.2 MaxMBPS 522,240) requires Level 5.1
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(900, 2012, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(2012, 900, 60),
        )

        // 1080x2414 (10,268 MBs > Level 4.2 MaxFS 8,704) requires Level 5.1 in portrait & landscape
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(1080, 2414, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(2414, 1080, 60),
        )

        // Capability resolution against CodecCapabilities.profileLevels
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = MediaCodecInfo.CodecProfileLevel.AVCLevel51,
                supportedLevelsForProfile = listOf(MediaCodecInfo.CodecProfileLevel.AVCLevel52),
            ),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = MediaCodecInfo.CodecProfileLevel.AVCLevel51,
                supportedLevelsForProfile = listOf(
                    MediaCodecInfo.CodecProfileLevel.AVCLevel42,
                    MediaCodecInfo.CodecProfileLevel.AVCLevel51,
                ),
            ),
        )
        // Older HAL capped below desired level -> falls back to highest supported level for profile
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel5,
            LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = MediaCodecInfo.CodecProfileLevel.AVCLevel51,
                supportedLevelsForProfile = listOf(
                    MediaCodecInfo.CodecProfileLevel.AVCLevel42,
                    MediaCodecInfo.CodecProfileLevel.AVCLevel5,
                ),
            ),
        )
        // Profile not advertised / empty list -> returns null so KEY_LEVEL is omitted for HAL auto-pick
        assertNull(
            LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = MediaCodecInfo.CodecProfileLevel.AVCLevel51,
                supportedLevelsForProfile = emptyList(),
            ),
        )
    }

    @Test
    fun `hardware codec scoring prioritizes Qualcomm Codec2 encoder`() {
        assertTrue(
            LowLatencyH264EncoderFactory.scoreHardwareAvcName("c2.qti.avc.encoder") >
                LowLatencyH264EncoderFactory.scoreHardwareAvcName("OMX.qcom.video.encoder.avc"),
        )
        assertTrue(
            LowLatencyH264EncoderFactory.scoreHardwareAvcName("c2.qti.avc.encoder") >
                LowLatencyH264EncoderFactory.scoreHardwareAvcName("c2.mtk.avc.encoder"),
        )
    }

    @Test
    fun `short-edge display scaling preserves 720p and 1080p quality in both portrait and landscape`() {
        // Flagship phone 1240x2772 @ BALANCED (900) -> portrait 900x2012, landscape 2012x900
        assertEquals(900 to 2012, DisplayScaleMath.computeScaledSize(1240, 2772, 900))
        assertEquals(2012 to 900, DisplayScaleMath.computeScaledSize(2772, 1240, 900))

        // Flagship phone 1240x2772 @ 720 -> portrait 720x1610, landscape 1610x720 (NOT 720x322!)
        assertEquals(720 to 1610, DisplayScaleMath.computeScaledSize(1240, 2772, 720))
        assertEquals(1610 to 720, DisplayScaleMath.computeScaledSize(2772, 1240, 720))

        // Flagship phone 1240x2772 @ HD (1080) -> crisp 1080x2414 (long-edge cap 2480 preserves full 1080p!)
        assertEquals(1080 to 2414, DisplayScaleMath.computeScaledSize(1240, 2772, 1080))
        assertEquals(2414 to 1080, DisplayScaleMath.computeScaledSize(2772, 1240, 1080))

        // Standard 1080x1920 @ HD (1080) -> native 1:1 in both orientations
        assertEquals(1080 to 1920, DisplayScaleMath.computeScaledSize(1080, 1920, 1080))
        assertEquals(1920 to 1080, DisplayScaleMath.computeScaledSize(1920, 1080, 1080))

        // Flagship phone 1240x2772 @ ECO (540) -> portrait 540x1206, landscape 1206x540
        assertEquals(540 to 1206, DisplayScaleMath.computeScaledSize(1240, 2772, 540))
        assertEquals(1206 to 540, DisplayScaleMath.computeScaledSize(2772, 1240, 540))

        // Smaller display never upscales
        assertEquals(480 to 800, DisplayScaleMath.computeScaledSize(480, 800, 720))

        // Output dimensions are always even for H.264/YUV420 compatibility
        val (oddW, oddH) = DisplayScaleMath.computeScaledSize(1081, 2341, 720)
        assertEquals(0, oddW % 2)
        assertEquals(0, oddH % 2)
    }
}
