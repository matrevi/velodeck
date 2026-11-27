package com.velodeck.agent.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Exact byte-for-byte Kotlin implementation of `@velodeck/protocol` binary media frame format.
 *
 * Wire layout (20-byte fixed Big-Endian header):
 * [0]          magic = 0x4D ('M')
 * [1]          frameType (0x01 = JPEG, 0x02 = H264)
 * [2..3]       width (uint16 BE)
 * [4..5]       height (uint16 BE)
 * [6]          rotation (0..3)
 * [7]          flags (bit 0 = keyframe)
 * [8..15]      timestampMs (uint64 BE)
 * [16..19]     sessionId byte length L (uint32 BE)
 * [20..20+L-1] sessionId UTF-8 bytes
 * [20+L..end]  payload bytes
 */
object BinaryMediaFrame {
    const val FRAME_MAGIC: Int = 0x4D
    const val FRAME_TYPE_JPEG: Int = 0x01
    const val FRAME_TYPE_H264: Int = 0x02
    const val FRAME_FLAG_KEYFRAME: Int = 0x01
    const val FRAME_HEADER_FIXED_SIZE: Int = 20
    const val MAX_SESSION_ID_BYTES: Int = 256

    data class MediaFrame(
        val frameType: Int,
        val width: Int,
        val height: Int,
        val rotation: Int,
        val keyframe: Boolean,
        val timestampMs: Long,
        val sessionId: String,
        val payload: ByteArray,
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is MediaFrame) return false
            return frameType == other.frameType &&
                width == other.width &&
                height == other.height &&
                rotation == other.rotation &&
                keyframe == other.keyframe &&
                timestampMs == other.timestampMs &&
                sessionId == other.sessionId &&
                payload.contentEquals(other.payload)
        }

        override fun hashCode(): Int {
            var result = frameType
            result = 31 * result + width
            result = 31 * result + height
            result = 31 * result + rotation
            result = 31 * result + keyframe.hashCode()
            result = 31 * result + timestampMs.hashCode()
            result = 31 * result + sessionId.hashCode()
            result = 31 * result + payload.contentHashCode()
            return result
        }
    }

    fun encode(frame: MediaFrame): ByteArray {
        require(frame.frameType == FRAME_TYPE_JPEG || frame.frameType == FRAME_TYPE_H264) {
            "Unsupported media frame type: ${frame.frameType}"
        }
        val sessionBytes = if (frame.sessionId.isNotEmpty()) {
            frame.sessionId.toByteArray(Charsets.UTF_8)
        } else {
            ByteArray(0)
        }
        require(sessionBytes.size <= MAX_SESSION_ID_BYTES) {
            "sessionId byte length ${sessionBytes.size} exceeds max $MAX_SESSION_ID_BYTES"
        }

        val totalLen = FRAME_HEADER_FIXED_SIZE + sessionBytes.size + frame.payload.size
        val out = ByteArray(totalLen)
        val buf = ByteBuffer.wrap(out).order(ByteOrder.BIG_ENDIAN)

        buf.put(0, FRAME_MAGIC.toByte())
        buf.put(1, frame.frameType.toByte())
        buf.putShort(2, (frame.width and 0xFFFF).toShort())
        buf.putShort(4, (frame.height and 0xFFFF).toShort())
        buf.put(6, (frame.rotation and 0x03).toByte())
        buf.put(7, if (frame.keyframe) FRAME_FLAG_KEYFRAME.toByte() else 0)
        buf.putLong(8, maxOf(0L, frame.timestampMs))
        buf.putInt(16, sessionBytes.size)

        if (sessionBytes.isNotEmpty()) {
            System.arraycopy(sessionBytes, 0, out, FRAME_HEADER_FIXED_SIZE, sessionBytes.size)
        }
        if (frame.payload.isNotEmpty()) {
            System.arraycopy(
                frame.payload,
                0,
                out,
                FRAME_HEADER_FIXED_SIZE + sessionBytes.size,
                frame.payload.size,
            )
        }
        return out
    }

    fun decode(bytes: ByteArray): MediaFrame {
        if (bytes.size < FRAME_HEADER_FIXED_SIZE) {
            throw IllegalArgumentException("Media frame too short: ${bytes.size} bytes")
        }
        val magic = bytes[0].toInt() and 0xFF
        if (magic != FRAME_MAGIC) {
            throw IllegalArgumentException("Invalid media frame magic: 0x${magic.toString(16)}")
        }
        val rawType = bytes[1].toInt() and 0xFF
        if (rawType != FRAME_TYPE_JPEG && rawType != FRAME_TYPE_H264) {
            throw IllegalArgumentException("Unsupported media frame type: $rawType")
        }

        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val width = buf.getShort(2).toInt() and 0xFFFF
        val height = buf.getShort(4).toInt() and 0xFFFF
        val rotation = bytes[6].toInt() and 0x03
        val keyframe = (bytes[7].toInt() and FRAME_FLAG_KEYFRAME) != 0
        val timestampMs = buf.getLong(8)
        val sessionLenUnsigned = buf.getInt(16).toLong() and 0xFFFFFFFFL

        if (sessionLenUnsigned > MAX_SESSION_ID_BYTES ||
            FRAME_HEADER_FIXED_SIZE + sessionLenUnsigned > bytes.size
        ) {
            throw IllegalArgumentException(
                "Invalid sessionId length $sessionLenUnsigned for frame of ${bytes.size} bytes",
            )
        }
        val sessionLen = sessionLenUnsigned.toInt()
        val payloadOffset = FRAME_HEADER_FIXED_SIZE + sessionLen
        val sessionId = if (sessionLen > 0) {
            String(bytes, FRAME_HEADER_FIXED_SIZE, sessionLen, Charsets.UTF_8)
        } else {
            ""
        }
        val payload = bytes.copyOfRange(payloadOffset, bytes.size)

        return MediaFrame(
            frameType = rawType,
            width = width,
            height = height,
            rotation = rotation,
            keyframe = keyframe,
            timestampMs = timestampMs,
            sessionId = sessionId,
            payload = payload,
        )
    }

    fun peekSessionId(bytes: ByteArray): String? {
        if (bytes.size < FRAME_HEADER_FIXED_SIZE) return null
        if ((bytes[0].toInt() and 0xFF) != FRAME_MAGIC) return null
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        val sessionLenUnsigned = buf.getInt(16).toLong() and 0xFFFFFFFFL
        if (sessionLenUnsigned == 0L ||
            sessionLenUnsigned > MAX_SESSION_ID_BYTES ||
            FRAME_HEADER_FIXED_SIZE + sessionLenUnsigned > bytes.size
        ) {
            return null
        }
        return String(bytes, FRAME_HEADER_FIXED_SIZE, sessionLenUnsigned.toInt(), Charsets.UTF_8)
    }
}
