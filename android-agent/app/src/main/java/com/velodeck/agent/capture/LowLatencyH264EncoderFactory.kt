package com.velodeck.agent.capture

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.VideoCodecInfo
import org.webrtc.VideoEncoder
import org.webrtc.VideoEncoderFactory
import org.webrtc.VideoEncoderFallback
import java.util.concurrent.atomic.AtomicReference

/**
 * Custom [VideoEncoderFactory] that puts our zero-copy [LowLatencyH264Encoder] (Constrained
 * Baseline 42e01f, clamped PTS, KEY_LOW_LATENCY=1, KEY_LATENCY=1, KEY_PRIORITY=0, intra-refresh)
 * in the #1 SDP codec slot whenever a hardware `video/avc` encoder is present, wrapped in
 * [VideoEncoderFallback] when a fallback encoder is available, while cleanly delegating
 * VP8/VP9/AV1 or fallback devices to stock [DefaultVideoEncoderFactory].
 */
class LowLatencyH264EncoderFactory(
    private val sharedContext: EglBase.Context,
) : VideoEncoderFactory {

    private data class HardwareAvcCandidate(
        val name: String,
        val supportsIntraRefresh: Boolean,
    )

    private val fallbackFactory = DefaultVideoEncoderFactory(sharedContext, true, true)
    private val hardwareAvc: HardwareAvcCandidate? = discoverBestHardwareAvcEncoder()
    private val activeEncoderRef = AtomicReference<LowLatencyH264Encoder?>(null)

    private val h264HighCodecInfo = VideoCodecInfo(
        "H264",
        mapOf(
            VideoCodecInfo.H264_FMTP_LEVEL_ASYMMETRY_ALLOWED to "1",
            VideoCodecInfo.H264_FMTP_PACKETIZATION_MODE to "1",
            VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID to VideoCodecInfo.H264_CONSTRAINED_HIGH_3_1,
        ),
        emptyList(),
    )

    private val h264BaselineCodecInfo = VideoCodecInfo(
        "H264",
        mapOf(
            VideoCodecInfo.H264_FMTP_LEVEL_ASYMMETRY_ALLOWED to "1",
            VideoCodecInfo.H264_FMTP_PACKETIZATION_MODE to "1",
            VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID to VideoCodecInfo.H264_CONSTRAINED_BASELINE_3_1,
        ),
        emptyList(),
    )

    init {
        if (hardwareAvc != null) {
            Log.i(
                TAG,
                "Selected hardware AVC encoder=${hardwareAvc.name} (intraRefresh=${hardwareAvc.supportsIntraRefresh})",
            )
        } else {
            Log.w(TAG, "No hardware AVC encoder discovered; delegating to DefaultVideoEncoderFactory")
        }
    }

    /**
     * Triggers an immediate hardware IDR keyframe on the currently active [LowLatencyH264Encoder].
     */
    fun requestSyncFrame() {
        activeEncoderRef.get()?.requestSyncFrame()
    }

    override fun createEncoder(info: VideoCodecInfo): VideoEncoder? {
        val candidate = hardwareAvc
        if (candidate != null && info.name.equals("H264", ignoreCase = true)) {
            val profileId = info.params[VideoCodecInfo.H264_FMTP_PROFILE_LEVEL_ID].orEmpty()
            val useHighProfile = profileId.startsWith("64", ignoreCase = true)
            Log.i(
                TAG,
                "Creating LowLatencyH264Encoder(${candidate.name}, highProfile=$useHighProfile) " +
                    "for codec=${info.name} params=${info.params}",
            )
            val primary = LowLatencyH264Encoder(
                codecName = candidate.name,
                supportsIntraRefresh = candidate.supportsIntraRefresh,
                sharedContext = sharedContext,
                useHighProfile = useHighProfile,
                onReleased = { released -> activeEncoderRef.compareAndSet(released, null) },
            )
            activeEncoderRef.set(primary)
            val fallback = fallbackFactory.createEncoder(info)
            return if (fallback != null) {
                VideoEncoderFallback(fallback, primary)
            } else {
                primary
            }
        }
        return fallbackFactory.createEncoder(info)
    }

    override fun getSupportedCodecs(): Array<VideoCodecInfo> {
        val result = ArrayList<VideoCodecInfo>()
        if (hardwareAvc != null) {
            // Slot #0: Constrained High (640c1f — CABAC + 8x8 DCT + 0 B-frames for razor-sharp UI text)
            // Slot #1: Constrained Baseline (42e01f — universal compatibility fallback)
            result.add(h264HighCodecInfo)
            result.add(h264BaselineCodecInfo)
        }
        for (codec in fallbackFactory.supportedCodecs) {
            // Avoid duplicating H264 entries if our custom low-latency H264 is already slot #0
            if (hardwareAvc != null && codec.name.equals("H264", ignoreCase = true)) {
                continue
            }
            result.add(codec)
        }
        return result.toTypedArray()
    }

    private fun discoverBestHardwareAvcEncoder(): HardwareAvcCandidate? {
        return try {
            val codecInfos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            val candidates = mutableListOf<Pair<Int, HardwareAvcCandidate>>()
            for (info in codecInfos) {
                if (!info.isEncoder) continue
                if (!info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, ignoreCase = true) }) {
                    continue
                }
                val name = info.name
                if (isSoftwareEncoder(info, name)) continue

                val caps = try {
                    info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                } catch (_: Throwable) {
                    continue
                }
                val supportsSurface = caps.colorFormats.any {
                    it == MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                }
                if (!supportsSurface) continue

                val supportsIntraRefresh = try {
                    caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_IntraRefresh)
                } catch (_: Throwable) {
                    false
                }
                val score = scoreHardwareAvcName(name) + if (supportsIntraRefresh) 10 else 0
                candidates.add(score to HardwareAvcCandidate(name, supportsIntraRefresh))
            }
            candidates.maxByOrNull { it.first }?.second
        } catch (t: Throwable) {
            Log.w(TAG, "Hardware AVC discovery failed", t)
            null
        }
    }

    private fun isSoftwareEncoder(info: MediaCodecInfo, name: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (info.isSoftwareOnly) return true
        }
        val lower = name.lowercase()
        return lower.startsWith("c2.android.") ||
            lower.startsWith("omx.google.") ||
            lower.contains(".sw.") ||
            lower.contains("ffmpeg")
    }

    internal companion object {
        private const val TAG = "LowLatencyH264Factory"

        fun scoreHardwareAvcName(name: String): Int {
            val lower = name.lowercase()
            return when {
                lower.startsWith("c2.qti.") -> 100
                lower.startsWith("c2.mtk.") || lower.startsWith("c2.exynos.") || lower.startsWith("c2.sec.") -> 90
                lower.startsWith("c2.") -> 80
                lower.startsWith("omx.qcom.") -> 70
                lower.startsWith("omx.exynos.") || lower.startsWith("omx.mtk.") || lower.startsWith("omx.hisi.") -> 60
                else -> 50
            }
        }
    }
}
