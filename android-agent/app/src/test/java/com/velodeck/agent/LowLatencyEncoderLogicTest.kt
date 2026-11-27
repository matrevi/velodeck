package com.velodeck.agent

import android.media.MediaCodecInfo
import android.os.Build
import com.velodeck.agent.capture.DisplayScaleMath
import com.velodeck.agent.capture.LowLatencyEncoderMath
import com.velodeck.agent.capture.LowLatencyH264EncoderFactory
import com.velodeck.agent.capture.WebRtcSessionManager
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LowLatencyEncoderLogicTest {

    @Test
    fun `nextClampedCodecPtsNs clamps motion by targetFps and caps repeated idle VBV credit`() {
        assertEquals(1_000_000_000L / 60, LowLatencyEncoderMath.MAX_FRAME_DELTA_NS)
        assertEquals(20_000_000L, LowLatencyEncoderMath.STATIC_SETTLE_DELTA_NS)
        assertEquals(3, LowLatencyEncoderMath.MAX_IN_FLIGHT_FRAMES)
        assertEquals(33_333_333L, LowLatencyEncoderMath.maxFrameDeltaNsForFps(30))
        assertEquals(16_666_666L, LowLatencyEncoderMath.maxFrameDeltaNsForFps(60))

        val pts0 = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = Long.MIN_VALUE,
            currentRealTsNs = 1_000_000_000L,
            previousCodecPtsNs = 0L,
            targetFps = 60,
            consecutiveIdleGaps = 0,
        )
        assertEquals(LowLatencyEncoderMath.DEFAULT_FRAME_DELTA_NS, pts0)

        // First idle gap (>= 180ms right after motion stops) -> grants at most ONE 20ms settle step
        val ptsFirstIdle = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 1_000_000_000L,
            currentRealTsNs = 1_250_000_000L,
            previousCodecPtsNs = pts0,
            targetFps = 60,
            consecutiveIdleGaps = 0,
        )
        assertEquals(pts0 + 20_000_000L, ptsFirstIdle)

        // Subsequent consecutive idle frames (>= 180ms) MUST use MIN_FRAME_DELTA_NS (8ms) — never keep crediting 20ms into VBV!
        val ptsSecondIdle = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 1_250_000_000L,
            currentRealTsNs = 2_750_000_000L,
            previousCodecPtsNs = ptsFirstIdle,
            targetFps = 60,
            consecutiveIdleGaps = 1,
        )
        assertEquals(ptsFirstIdle + LowLatencyEncoderMath.MIN_FRAME_DELTA_NS, ptsSecondIdle)

        val ptsThirdIdle = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 2_750_000_000L,
            currentRealTsNs = 4_250_000_000L,
            previousCodecPtsNs = ptsSecondIdle,
            targetFps = 60,
            consecutiveIdleGaps = 2,
        )
        assertEquals(ptsSecondIdle + LowLatencyEncoderMath.MIN_FRAME_DELTA_NS, ptsThirdIdle)

        // Active 60fps scrolling (~16.666ms delta) passes through cleanly
        val ptsScrolling = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 4_250_000_000L,
            currentRealTsNs = 4_266_666_666L,
            previousCodecPtsNs = ptsThirdIdle,
            targetFps = 60,
            consecutiveIdleGaps = 0,
        )
        assertEquals(ptsThirdIdle + 16_666_666L, ptsScrolling)

        // 30fps motion under 60fps target clamps to 16.666ms
        val pts30fpsAt60Target = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 4_266_666_666L,
            currentRealTsNs = 4_300_000_000L,
            previousCodecPtsNs = ptsScrolling,
            targetFps = 60,
            consecutiveIdleGaps = 0,
        )
        assertEquals(ptsScrolling + 16_666_666L, pts30fpsAt60Target)

        // 30fps ECO target scales MAX_FRAME_DELTA_NS to 33.333ms so ECO never gets 16.67ms PTS starvation!
        val pts30fpsEco = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 4_300_000_000L,
            currentRealTsNs = 4_333_333_333L,
            previousCodecPtsNs = pts30fpsAt60Target,
            targetFps = 30,
            consecutiveIdleGaps = 0,
        )
        assertEquals(pts30fpsAt60Target + 33_333_333L, pts30fpsEco)

        // Duplicate / backwards timestamp clamps cleanly to MIN_FRAME_DELTA_NS (8ms)
        val ptsDup = LowLatencyEncoderMath.nextClampedCodecPtsNs(
            previousRealTsNs = 4_333_333_333L,
            currentRealTsNs = 4_333_333_333L,
            previousCodecPtsNs = pts30fpsEco,
            targetFps = 60,
            consecutiveIdleGaps = 0,
        )
        assertEquals(pts30fpsEco + LowLatencyEncoderMath.MIN_FRAME_DELTA_NS, ptsDup)

        // VBV re-arm bitrate helper nudges to 75% and guarantees distinct value on repeated re-arm
        assertEquals(3_000_000, LowLatencyEncoderMath.computeVbvRearmBitrateBps(4_000_000))
        assertEquals(2_999_000, LowLatencyEncoderMath.computeVbvRearmBitrateBps(4_000_000, 3_000_000))
        assertEquals(LowLatencyEncoderMath.MIN_BITRATE_BPS, LowLatencyEncoderMath.computeVbvRearmBitrateBps(300_000))

        // Static frame pump backs off to 1500ms after 3s startup and 1s post-motion settle
        assertEquals(250L, LowLatencyEncoderMath.computeStaticPumpIntervalMs(sessionAgeMs = 1_500L, sinceLastRealFrameMs = 5_000L))
        assertEquals(250L, LowLatencyEncoderMath.computeStaticPumpIntervalMs(sessionAgeMs = 10_000L, sinceLastRealFrameMs = 600L))
        assertEquals(1_500L, LowLatencyEncoderMath.computeStaticPumpIntervalMs(sessionAgeMs = 10_000L, sinceLastRealFrameMs = 1_200L))
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
        assertEquals(300_000, LowLatencyEncoderMath.MIN_BITRATE_BPS)
        assertEquals(LowLatencyEncoderMath.MIN_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(100_000))
        assertEquals(LowLatencyEncoderMath.MAX_BITRATE_BPS, LowLatencyEncoderMath.clampBitrateBps(25_000_000))

        // WAN/TURN-friendly per-resolution floors
        assertEquals(300_000, LowLatencyEncoderMath.minBitrateForResolution(540, 1206))
        assertEquals(350_000, LowLatencyEncoderMath.minBitrateForResolution(720, 1610))
        assertEquals(400_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012))
        assertEquals(500_000, LowLatencyEncoderMath.minBitrateForResolution(2414, 1080))
        assertEquals(
            350_000,
            LowLatencyEncoderMath.clampBitrateBps(200_000, LowLatencyEncoderMath.minBitrateForResolution(720, 1610)),
        )
        assertEquals(
            400_000,
            LowLatencyEncoderMath.clampBitrateBps(320_000, LowLatencyEncoderMath.minBitrateForResolution(900, 2012)),
        )
        assertEquals(
            500_000,
            LowLatencyEncoderMath.clampBitrateBps(420_000, LowLatencyEncoderMath.minBitrateForResolution(1080, 2414)),
        )

        // Bounded Android 12+ QP caps prevent QP-12 VBV explosions and QP-38 FrameDropper spirals
        assertEquals(20, LowLatencyEncoderMath.QP_MIN)
        assertEquals(42, LowLatencyEncoderMath.QP_I_MAX)
        assertEquals(46, LowLatencyEncoderMath.QP_P_MAX)

        // Adaptive SDP/sender min (15% clamped 300..600 kbps) and start (55% clamped 1200..4000 kbps)
        assertEquals(300, LowLatencyEncoderMath.computeSdpMinBitrateKbps(1_600))   // ECO
        assertEquals(360, LowLatencyEncoderMath.computeSdpMinBitrateKbps(2_400))   // 720p
        assertEquals(600, LowLatencyEncoderMath.computeSdpMinBitrateKbps(4_500))   // BALANCED
        assertEquals(600, LowLatencyEncoderMath.computeSdpMinBitrateKbps(7_500))   // HD
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
    fun `selectAvcLevel, selectAvcProfile, and resolveSupportedAvcLevel pick Level 5_2 for 1080x2414 and prefer Constrained High`() {
        assertEquals(983_040L, LowLatencyEncoderMath.AVC_LEVEL_51_MAX_MBPS)

        // 720p (1280x720 = 3,600 MBs, *120 = 432,000 <= 522,240) and ECO 540x1206 fit Level 4.2
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel42,
            LowLatencyEncoderMath.selectAvcLevel(1280, 720, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel42,
            LowLatencyEncoderMath.selectAvcLevel(540, 1206, 30),
        )

        // 900x2012 (7,182 MBs * 120 = 861,840) and 1080x1920 (8,160 MBs * 120 = 979,200 <= 983,040) fit Level 5.1
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(900, 2012, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(2012, 900, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel51,
            LowLatencyEncoderMath.selectAvcLevel(1080, 1920, 60),
        )

        // 1080x2414 (10,268 MBs * 120fps = 1,232,160 > Level 5.1 MaxMBPS 983,040) requires Level 5.2 in portrait & landscape
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel52,
            LowLatencyEncoderMath.selectAvcLevel(1080, 2414, 60),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel52,
            LowLatencyEncoderMath.selectAvcLevel(2414, 1080, 60),
        )

        // Constrained High preference on API 27+ avoids 2-4 frame decoder DPB reorder lag
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh,
            LowLatencyEncoderMath.selectAvcProfile(
                useHighProfile = true,
                supportedProfiles = setOf(
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh,
                ),
                sdkInt = Build.VERSION_CODES.O_MR1,
            ),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
            LowLatencyEncoderMath.selectAvcProfile(
                useHighProfile = true,
                supportedProfiles = setOf(
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
                ),
                sdkInt = Build.VERSION_CODES.O_MR1,
            ),
        )
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline,
            LowLatencyEncoderMath.selectAvcProfile(
                useHighProfile = true,
                supportedProfiles = setOf(
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline,
                ),
                sdkInt = Build.VERSION_CODES.O_MR1,
            ),
        )
        // API 26 falls back cleanly to plain High / Baseline
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
            LowLatencyEncoderMath.selectAvcProfile(
                useHighProfile = true,
                supportedProfiles = setOf(
                    MediaCodecInfo.CodecProfileLevel.AVCProfileHigh,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedHigh,
                ),
                sdkInt = Build.VERSION_CODES.O,
            ),
        )

        // Capability resolution against CodecCapabilities.profileLevels
        assertEquals(
            MediaCodecInfo.CodecProfileLevel.AVCLevel52,
            LowLatencyEncoderMath.resolveSupportedAvcLevel(
                desiredLevel = MediaCodecInfo.CodecProfileLevel.AVCLevel52,
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
    fun `injectSdpBitrateHints replaces existing b=AS after c= without inserting duplicates`() {
        val sdpWithExistingAs = listOf(
            "v=0",
            "o=- 123 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "m=audio 9 UDP/TLS/RTP/SAVPF 111",
            "c=IN IP4 0.0.0.0",
            "b=AS:64",
            "a=rtpmap:111 opus/48000/2",
            "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
            "c=IN IP4 0.0.0.0",
            "b=AS:2000",
            "a=rtpmap:96 H264/90000",
            "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
            "a=rtpmap:97 rtx/90000",
            "a=fmtp:97 apt=96",
        ).joinToString("\r\n")

        val injectedOnce = WebRtcSessionManager.injectSdpBitrateHints(
            sdp = sdpWithExistingAs,
            minKbps = 600,
            startKbps = 2_475,
            sessionCeilingKbps = 10_000,
        )
        val videoSectionOnce = injectedOnce.substringAfter("m=video ")
        val videoAsLinesOnce = videoSectionOnce.split("\r\n").filter { it.startsWith("b=AS:") }
        assertEquals(listOf("b=AS:10000"), videoAsLinesOnce)
        assertTrue(injectedOnce.contains("b=AS:64\r\n"))
        assertTrue(
            injectedOnce.contains(
                "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f;" +
                    "x-google-min-bitrate=600;x-google-start-bitrate=2475;x-google-max-bitrate=10000",
            ),
        )
        assertFalse(injectedOnce.contains("a=fmtp:97 apt=96;x-google-min-bitrate"))

        // Idempotency: re-running injectSdpBitrateHints never creates a second b=AS: line
        val injectedTwice = WebRtcSessionManager.injectSdpBitrateHints(
            sdp = injectedOnce,
            minKbps = 600,
            startKbps = 2_475,
            sessionCeilingKbps = 10_000,
        )
        val videoAsLinesTwice = injectedTwice.substringAfter("m=video ").split("\r\n").filter { it.startsWith("b=AS:") }
        assertEquals(listOf("b=AS:10000"), videoAsLinesTwice)

        // When b=AS: is absent, inserts exactly one b=AS: right after c=
        val sdpWithoutAs = listOf(
            "v=0",
            "m=video 9 UDP/TLS/RTP/SAVPF 96",
            "c=IN IP4 0.0.0.0",
            "a=fmtp:96 packetization-mode=1",
        ).joinToString("\r\n")
        val injectedFresh = WebRtcSessionManager.injectSdpBitrateHints(
            sdp = sdpWithoutAs,
            minKbps = 300,
            startKbps = 1_200,
            sessionCeilingKbps = 10_000,
        )
        val freshLines = injectedFresh.split("\r\n")
        assertEquals(1, freshLines.count { it.startsWith("b=AS:") })
        assertEquals("c=IN IP4 0.0.0.0", freshLines[2])
        assertEquals("b=AS:10000", freshLines[3])
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
