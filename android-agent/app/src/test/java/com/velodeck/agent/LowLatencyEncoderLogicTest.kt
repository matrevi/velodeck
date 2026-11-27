package com.velodeck.agent

import com.velodeck.agent.capture.DisplayScaleMath
import com.velodeck.agent.capture.LowLatencyEncoderMath
import com.velodeck.agent.capture.LowLatencyH264EncoderFactory
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun `bitrate clamping and tightened 150ms 3-percent threshold guard behave correctly`() {
        assertEquals(150L, LowLatencyEncoderMath.BITRATE_UPDATE_MIN_INTERVAL_MS)
        assertEquals(0.03, LowLatencyEncoderMath.BITRATE_CHANGE_THRESHOLD_RATIO, 1e-9)
        assertEquals(LowLatencyEncoderMath.MIN_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(100_000))
        assertEquals(LowLatencyEncoderMath.MAX_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(25_000_000))
        assertEquals(2_200_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012))
        assertEquals(3_200_000, LowLatencyEncoderMath.minBitrateForResolution(2414, 1080))
        assertEquals(
            2_200_000,
            LowLatencyEncoderMath.clampBitrateBps(900_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012)),
        )

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
