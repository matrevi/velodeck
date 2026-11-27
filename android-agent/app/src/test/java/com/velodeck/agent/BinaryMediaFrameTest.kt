package com.velodeck.agent

import com.velodeck.agent.protocol.BinaryMediaFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class BinaryMediaFrameTest {

    @Test
    fun encodeAndDecode_exact20ByteBigEndianHeaderLayout() {
        val payload = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0x11, 0x22, 0xFF.toByte(), 0xD9.toByte())
        val ts = 1_764_123_456_789L
        val sessionId = "sess-abc-123"
        val frame = BinaryMediaFrame.MediaFrame(
            frameType = BinaryMediaFrame.FRAME_TYPE_JPEG,
            width = 720,
            height = 1600,
            rotation = 2,
            keyframe = true,
            timestampMs = ts,
            sessionId = sessionId,
            payload = payload,
        )

        val encoded = BinaryMediaFrame.encode(frame)
        val sessionBytes = sessionId.toByteArray(Charsets.UTF_8)
        assertEquals(20 + sessionBytes.size + payload.size, encoded.size)

        // Verify exact raw header bytes in Big-Endian order
        val buf = ByteBuffer.wrap(encoded).order(ByteOrder.BIG_ENDIAN)
        assertEquals(0x4D, encoded[0].toInt() and 0xFF)
        assertEquals(0x01, encoded[1].toInt() and 0xFF)
        assertEquals(720, buf.getShort(2).toInt() and 0xFFFF)
        assertEquals(1600, buf.getShort(4).toInt() and 0xFFFF)
        assertEquals(2, encoded[6].toInt() and 0xFF)
        assertEquals(0x01, encoded[7].toInt() and 0xFF)
        assertEquals(ts, buf.getLong(8))
        assertEquals(sessionBytes.size, buf.getInt(16))

        // Verify fast session peek
        assertEquals(sessionId, BinaryMediaFrame.peekSessionId(encoded))

        // Verify full decode round-trip
        val decoded = BinaryMediaFrame.decode(encoded)
        assertEquals(frame, decoded)
        assertArrayEquals(payload, decoded.payload)
    }

    @Test
    fun encodeAndDecode_directModeEmptySessionIdAndH264NonKeyframe() {
        val payload = byteArrayOf(0x00, 0x00, 0x00, 0x01, 0x41)
        val frame = BinaryMediaFrame.MediaFrame(
            frameType = BinaryMediaFrame.FRAME_TYPE_H264,
            width = 1080,
            height = 2400,
            rotation = 0,
            keyframe = false,
            timestampMs = 42L,
            sessionId = "",
            payload = payload,
        )

        val encoded = BinaryMediaFrame.encode(frame)
        assertEquals(20 + payload.size, encoded.size)
        assertEquals(0x02, encoded[1].toInt() and 0xFF)
        assertEquals(0x00, encoded[7].toInt() and 0xFF)
        assertNull(BinaryMediaFrame.peekSessionId(encoded))

        val decoded = BinaryMediaFrame.decode(encoded)
        assertEquals("", decoded.sessionId)
        assertFalse(decoded.keyframe)
        assertEquals(BinaryMediaFrame.FRAME_TYPE_H264, decoded.frameType)
        assertArrayEquals(payload, decoded.payload)
    }

    @Test(expected = IllegalArgumentException::class)
    fun decode_rejectsBadMagic() {
        val bad = ByteArray(24)
        bad[0] = 0x58
        BinaryMediaFrame.decode(bad)
    }

    @Test(expected = IllegalArgumentException::class)
    fun decode_rejectsTruncatedFrame() {
        BinaryMediaFrame.decode(ByteArray(19))
    }

    @Test
    fun encode_masksRotationTo2BitsAndClampsNegativeTimestamp() {
        val encoded = BinaryMediaFrame.encode(
            BinaryMediaFrame.MediaFrame(
                frameType = BinaryMediaFrame.FRAME_TYPE_JPEG,
                width = 480,
                height = 960,
                rotation = 7,
                keyframe = true,
                timestampMs = -500L,
                sessionId = "s1",
                payload = byteArrayOf(1),
            ),
        )
        val decoded = BinaryMediaFrame.decode(encoded)
        assertEquals(3, decoded.rotation)
        assertEquals(0L, decoded.timestampMs)
        assertTrue(decoded.keyframe)
    }
}
