package com.velodeck.agent

import com.velodeck.agent.protocol.DeviceCapabilities
import com.velodeck.agent.protocol.DeviceSummary
import com.velodeck.agent.protocol.PartialDeviceCapabilities
import com.velodeck.agent.protocol.ProtocolCodec
import com.velodeck.agent.protocol.WireMessage
import com.velodeck.agent.transfer.FileTransferManager
import com.velodeck.agent.transfer.FileTransferUtils
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class FileTransferLogicTest {

    @Test
    fun sanitizeFileName_stripsTraversalSlashesControlCharsAndLeadingDots() {
        assertEquals("evil.apk", FileTransferUtils.sanitizeFileName("../../evil.apk", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("evil.apk", FileTransferUtils.sanitizeFileName("..\\..\\evil.apk", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("evil.apk", FileTransferUtils.sanitizeFileName("....//....//evil.apk", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("passwd", FileTransferUtils.sanitizeFileName("/etc/passwd", FileTransferUtils.PURPOSE_FILE))
        assertEquals("report.pdf", FileTransferUtils.sanitizeFileName("dir/sub\\report.pdf", FileTransferUtils.PURPOSE_FILE))
        assertEquals("hidden.txt", FileTransferUtils.sanitizeFileName("...hidden.txt", FileTransferUtils.PURPOSE_FILE))
        assertEquals("spaced.txt", FileTransferUtils.sanitizeFileName(" . . . spaced.txt  ", FileTransferUtils.PURPOSE_FILE))
        assertEquals("clean.bin", FileTransferUtils.sanitizeFileName("cl\u0000ea\r\n\t\u007fn.bin", FileTransferUtils.PURPOSE_FILE))
        assertEquals("a.b.txt", FileTransferUtils.sanitizeFileName("a..b..txt", FileTransferUtils.PURPOSE_FILE))
        assertEquals("测试文件 2026.pdf", FileTransferUtils.sanitizeFileName("  测试文件 2026.pdf  ", FileTransferUtils.PURPOSE_FILE))

        // Verify no path separators or traversal sequences ever survive
        val dirtySamples = listOf(
            "../../evil.apk",
            "a/b\\c/..d..e.apk",
            "C:\\Windows\\System32\\cmd.exe",
            "foo/bar/../../baz.txt",
        )
        for (sample in dirtySamples) {
            val cleaned = FileTransferUtils.sanitizeFileName(sample, FileTransferUtils.PURPOSE_FILE)
            assertFalse("Slash leaked for $sample -> $cleaned", cleaned.contains('/'))
            assertFalse("Backslash leaked for $sample -> $cleaned", cleaned.contains('\\'))
            assertFalse("Dotdot leaked for $sample -> $cleaned", cleaned.contains(".."))
            assertFalse("Leading dot leaked for $sample -> $cleaned", cleaned.startsWith('.'))
        }
    }

    @Test
    fun sanitizeFileName_fallbacksAndLengthCapPreserveExtension() {
        assertEquals("velodeck-update.apk", FileTransferUtils.sanitizeFileName(null, FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("velodeck-update.apk", FileTransferUtils.sanitizeFileName("", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("velodeck-update.apk", FileTransferUtils.sanitizeFileName("   ", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("velodeck-update.apk", FileTransferUtils.sanitizeFileName("../..", FileTransferUtils.PURPOSE_APK_INSTALL))
        assertEquals("velodeck-update.apk", FileTransferUtils.sanitizeFileName("/", FileTransferUtils.PURPOSE_APK_INSTALL))

        assertEquals("received_file", FileTransferUtils.sanitizeFileName(null, FileTransferUtils.PURPOSE_FILE))
        assertEquals("received_file", FileTransferUtils.sanitizeFileName("...", FileTransferUtils.PURPOSE_FILE))
        assertEquals("received_file", FileTransferUtils.sanitizeFileName("\\\\", FileTransferUtils.PURPOSE_FILE))
        assertEquals("received_file", FileTransferUtils.sanitizeFileName("\u0000\n\r", FileTransferUtils.PURPOSE_FILE))

        // Long filename with extension should be capped at 120 chars and retain extension
        val longApk = "a".repeat(180) + ".apk"
        val cappedApk = FileTransferUtils.sanitizeFileName(longApk, FileTransferUtils.PURPOSE_APK_INSTALL)
        assertEquals(FileTransferUtils.MAX_FILE_NAME_LENGTH, cappedApk.length)
        assertTrue(cappedApk.endsWith(".apk"))

        // Long filename without extension should be capped at 120 chars
        val longNoExt = "x".repeat(200)
        val cappedNoExt = FileTransferUtils.sanitizeFileName(longNoExt, FileTransferUtils.PURPOSE_FILE)
        assertEquals(FileTransferUtils.MAX_FILE_NAME_LENGTH, cappedNoExt.length)

        // Long filename with overly long bogus extension (> 20 chars) still caps at 120
        val hugeExt = "a." + "b".repeat(150)
        val cappedHugeExt = FileTransferUtils.sanitizeFileName(hugeExt, FileTransferUtils.PURPOSE_FILE)
        assertEquals(FileTransferUtils.MAX_FILE_NAME_LENGTH, cappedHugeExt.length)
    }

    @Test
    fun validateOffer_enforcesSizeCapsPurposeAndRequiredFields() {
        // Valid boundary cases
        assertNull(FileTransferUtils.validateOffer("t-1", "photo.jpg", 1L, FileTransferUtils.PURPOSE_FILE))
        assertNull(
            FileTransferUtils.validateOffer(
                "t-2",
                "archive.zip",
                FileTransferUtils.MAX_FILE_BYTES,
                FileTransferUtils.PURPOSE_FILE,
            ),
        )
        assertNull(FileTransferUtils.validateOffer("t-3", "velodeck.apk", 1024L, FileTransferUtils.PURPOSE_APK_INSTALL))
        assertNull(
            FileTransferUtils.validateOffer(
                "t-4",
                "velodeck.apk",
                FileTransferUtils.MAX_APK_BYTES,
                FileTransferUtils.PURPOSE_APK_INSTALL,
            ),
        )

        // Exceeds size caps
        assertNotNull(
            FileTransferUtils.validateOffer(
                "t-5",
                "huge.bin",
                FileTransferUtils.MAX_FILE_BYTES + 1L,
                FileTransferUtils.PURPOSE_FILE,
            ),
        )
        assertNotNull(
            FileTransferUtils.validateOffer(
                "t-6",
                "huge.apk",
                FileTransferUtils.MAX_APK_BYTES + 1L,
                FileTransferUtils.PURPOSE_APK_INSTALL,
            ),
        )

        // Zero & negative sizes
        assertNotNull(FileTransferUtils.validateOffer("t-7", "empty.txt", 0L, FileTransferUtils.PURPOSE_FILE))
        assertNotNull(FileTransferUtils.validateOffer("t-8", "neg.txt", -100L, FileTransferUtils.PURPOSE_FILE))
        assertNotNull(FileTransferUtils.validateOffer("t-9", "min.apk", Long.MIN_VALUE, FileTransferUtils.PURPOSE_APK_INSTALL))

        // Invalid purpose
        assertNotNull(FileTransferUtils.validateOffer("t-10", "a.txt", 100L, "shell_exec"))
        assertNotNull(FileTransferUtils.validateOffer("t-11", "a.txt", 100L, ""))
        assertNotNull(FileTransferUtils.validateOffer("t-12", "a.txt", 100L, null))

        // Missing transferId or fileName
        assertNotNull(FileTransferUtils.validateOffer("", "a.txt", 100L, FileTransferUtils.PURPOSE_FILE))
        assertNotNull(FileTransferUtils.validateOffer(null, "a.txt", 100L, FileTransferUtils.PURPOSE_FILE))
        assertNotNull(FileTransferUtils.validateOffer("t-13", "", 100L, FileTransferUtils.PURPOSE_FILE))
        assertNotNull(FileTransferUtils.validateOffer("t-14", "   ", 100L, FileTransferUtils.PURPOSE_FILE))
    }

    @Test
    fun normalizeSha256_validatesAndLowercasesHex() {
        val upper = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
        val lower = upper.lowercase()
        assertEquals(lower, FileTransferUtils.normalizeSha256(lower))
        assertEquals(lower, FileTransferUtils.normalizeSha256("  $upper  "))

        assertNull(FileTransferUtils.normalizeSha256(null))
        assertNull(FileTransferUtils.normalizeSha256(""))
        assertNull(FileTransferUtils.normalizeSha256(lower.dropLast(1))) // 63 chars
        assertNull(FileTransferUtils.normalizeSha256(lower + "a")) // 65 chars
        assertNull(FileTransferUtils.normalizeSha256("g" + lower.drop(1))) // non-hex char
        assertNull(FileTransferUtils.normalizeSha256(lower.replace('a', ' '))) // space inside
    }

    @Test
    fun isZipMagicAndBytesToHex_verifyBinarySignaturesAndDigests() {
        assertTrue(FileTransferUtils.isZipMagic(byteArrayOf(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00)))
        assertTrue(FileTransferUtils.isZipMagic(byteArrayOf(0x50, 0x4B, 0x05, 0x06)))
        assertTrue(FileTransferUtils.isZipMagic(byteArrayOf(0x50, 0x4B, 0x07, 0x08)))

        assertFalse(FileTransferUtils.isZipMagic(byteArrayOf()))
        assertFalse(FileTransferUtils.isZipMagic(byteArrayOf(0x50, 0x4B)))
        assertFalse(FileTransferUtils.isZipMagic(byteArrayOf(0x50, 0x4B, 0x00, 0x00)))
        assertFalse(FileTransferUtils.isZipMagic("<html>not apk</html>".toByteArray()))

        val emptySha = FileTransferUtils.bytesToHex(MessageDigest.getInstance("SHA-256").digest(ByteArray(0)))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", emptySha)

        val helloSha = FileTransferUtils.bytesToHex(
            MessageDigest.getInstance("SHA-256").digest("hello".toByteArray(Charsets.UTF_8)),
        )
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", helloSha)
    }

    @Test
    fun protocolCodec_roundTripsP2pFileTransferCapability() {
        val capsWithTrue = DeviceCapabilities(
            webrtc = true,
            wsJpeg = true,
            wsH264 = false,
            wake = true,
            unlock = true,
            accessibility = true,
            mediaProjection = true,
            rootOrShizuku = false,
            p2pFileTransfer = true,
        )
        val reg = WireMessage.AgentRegister(
            deviceId = "android-ota-1",
            deviceSecret = "sec-ota",
            name = "Pixel OTA",
            model = "Google Pixel",
            androidVersion = "16",
            screenWidth = 1080,
            screenHeight = 2400,
            rotation = 0,
            battery = 95,
            charging = true,
            locked = false,
            capabilities = capsWithTrue,
        )
        val regJson = ProtocolCodec.serialize(reg)
        assertTrue("Expected p2pFileTransfer:true in JSON: $regJson", regJson.contains("\"p2pFileTransfer\":true"))
        val decodedReg = ProtocolCodec.parse(regJson) as WireMessage.AgentRegister
        assertEquals(true, decodedReg.capabilities.p2pFileTransfer)

        // DeviceStatus round-trip with p2pFileTransfer = false
        val summary = DeviceSummary(
            deviceId = "android-ota-2",
            name = "Test",
            model = "Model",
            androidVersion = "15",
            online = true,
            lastSeen = 1760000000000L,
            screenWidth = 1080,
            screenHeight = 2400,
            rotation = 0,
            battery = 80,
            charging = false,
            locked = false,
            capabilities = capsWithTrue.copy(p2pFileTransfer = false),
        )
        val decodedStatus = ProtocolCodec.parse(
            ProtocolCodec.serialize(WireMessage.DeviceStatus(summary)),
        ) as WireMessage.DeviceStatus
        assertEquals(false, decodedStatus.device.capabilities.p2pFileTransfer)

        // Null p2pFileTransfer omitted from JSON
        val capsWithNull = capsWithTrue.copy(p2pFileTransfer = null)
        val nullCapsJson = ProtocolCodec.capabilitiesToJson(capsWithNull).toString()
        assertFalse(nullCapsJson.contains("p2pFileTransfer"))
        assertNull(ProtocolCodec.capabilitiesFromJson(ProtocolCodec.capabilitiesToJson(capsWithNull)).p2pFileTransfer)

        // PartialDeviceCapabilities in AgentTelemetry round-trip
        val telemetry = WireMessage.AgentTelemetry(
            deviceId = "android-ota-1",
            capabilities = PartialDeviceCapabilities(
                webrtc = true,
                p2pFileTransfer = true,
            ),
        )
        val telemetryJson = ProtocolCodec.serialize(telemetry)
        assertTrue(telemetryJson.contains("\"p2pFileTransfer\":true"))
        val decodedTelemetry = ProtocolCodec.parse(telemetryJson) as WireMessage.AgentTelemetry
        assertEquals(true, decodedTelemetry.capabilities?.p2pFileTransfer)

        val telemetryWithoutFlag = WireMessage.AgentTelemetry(
            deviceId = "android-ota-1",
            capabilities = PartialDeviceCapabilities(webrtc = false, p2pFileTransfer = null),
        )
        val telemetryWithoutJson = ProtocolCodec.serialize(telemetryWithoutFlag)
        assertFalse(telemetryWithoutJson.contains("p2pFileTransfer"))
        val decodedWithout = ProtocolCodec.parse(telemetryWithoutJson) as WireMessage.AgentTelemetry
        assertNull(decodedWithout.capabilities?.p2pFileTransfer)
    }

    @Test
    fun otaApkFileNameForSha256_producesUniqueLowercaseHexNamesWithLatestFallback() {
        val sha1 = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855"
        val sha2 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

        val file1 = FileTransferUtils.otaApkFileNameForSha256("  $sha1  ")
        val file2 = FileTransferUtils.otaApkFileNameForSha256(sha2)
        assertEquals("velodeck-ota-e3b0c44298fc.apk", file1)
        assertEquals("velodeck-ota-2cf24dba5fb0.apk", file2)
        assertNotEquals(file1, file2)

        assertEquals("velodeck-ota-abcdef012345.apk", FileTransferUtils.otaApkFileNameForSha256("ABCDEF012345"))
        assertEquals("velodeck-ota-latest.apk", FileTransferUtils.otaApkFileNameForSha256(""))
        assertEquals("velodeck-ota-latest.apk", FileTransferUtils.otaApkFileNameForSha256("   "))
        assertEquals("velodeck-ota-latest.apk", FileTransferUtils.otaApkFileNameForSha256("abcdef01234"))
        assertEquals("velodeck-ota-latest.apk", FileTransferUtils.otaApkFileNameForSha256("zzzzzzzzzzzzzzzz"))
    }

    @Test
    fun pruneStaleOtaApks_removesOldOtaAndLegacyFilesWhilePreservingCurrentAndUnrelated() {
        val otaDir = Files.createTempDirectory("velodeck-p2p-ota-prune").toFile()
        try {
            val currentOta = File(otaDir, "velodeck-ota-2cf24dba5fb0.apk").apply { writeText("new") }
            val oldOta = File(otaDir, "velodeck-ota-e3b0c44298fc.apk").apply { writeText("old") }
            val legacyOta = File(otaDir, "velodeck-update.apk").apply { writeText("legacy") }
            val selfUpdateApk = File(otaDir, "velodeck-self-update-111122223333.apk").apply { writeText("self") }
            val incomingTmp = File(otaDir, "incoming_abc.tmp").apply { writeText("tmp") }

            FileTransferManager.pruneStaleOtaApks(otaDir, keepFileName = currentOta.name)

            assertTrue(currentOta.exists())
            assertFalse(oldOta.exists())
            assertFalse(legacyOta.exists())
            assertTrue(selfUpdateApk.exists())
            assertTrue(incomingTmp.exists())
        } finally {
            otaDir.deleteRecursively()
        }
    }
}
